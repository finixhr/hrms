// Seed helpers: attendance upsert without HTTP context + template rendering
import { db } from "@/lib/db"
import { computeAttendance } from "./routes/attendance"
import { resolveShiftForSeed } from "./seed-helpers-shift"

export async function upsertForSeed(ctx: any, p: any, source: string) {
  const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: ctx.vendorId } })
  if (!emp) throw new Error("employee not found for seed attendance")
  const shift = await resolveShiftForSeed(ctx.vendorId, emp.id, emp.shiftId, p.date)

  if (p.status && ["LEAVE", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP", "ABSENT"].includes(p.status)) {
    const existing = await db.attendance.findFirst({ where: { vendorId: ctx.vendorId, employeeId: emp.id, date: p.date } })
    if (existing) {
      return db.attendance.update({ where: { id: existing.id }, data: { status: p.status, source } })
    }
    return db.attendance.create({
      data: { vendorId: ctx.vendorId, employeeId: emp.id, date: p.date, shiftId: shift?.id || null, status: p.status, source },
    })
  }
  const calc = computeAttendance(shift, p.checkIn, p.checkOut || null)
  const data: any = {
    vendorId: ctx.vendorId, employeeId: emp.id, date: p.date, shiftId: shift?.id || null,
    checkIn: p.checkIn, checkOut: p.checkOut || null,
    workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
    earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes,
    status: calc.status, source, deviceInfo: source === "BIOMETRIC" ? "ZK-U550" : source,
  }
  const existing = await db.attendance.findFirst({ where: { vendorId: ctx.vendorId, employeeId: emp.id, date: p.date } })
  if (existing) return db.attendance.update({ where: { id: existing.id }, data })
  return db.attendance.create({ data })
}

export function renderTemplate(body: string, vars: Record<string, string>) {
  let out = body
  for (const [k, val] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi"), val)
  }
  return out
}

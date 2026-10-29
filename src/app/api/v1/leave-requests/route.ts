// ============ POST /api/v1/leave-requests — public REST API (leave:write) ===
// Create a leave request { employeeId, typeCode, startDate, endDate, reason? }.
//
// LVE-013 (R3-4) — API-filed requests used to be plain PENDING rows with no
// approval request, no balance reservation and no decision path: they sat
// pending FOREVER (the only decision path is the approval engine, which they
// never entered) and the API_NOTE even claimed they appear in the normal
// pending queue — false. The route now files through the SAME engine the
// in-app path uses:
//   * server-computed working-day count (weekly-off + holiday aware, the
//     caller's balance reserved as PENDING exactly like leaveRequests.apply);
//   * submitForApproval(LEAVE) with a synthetic system ctx, so the request
//     shows up in the approval inbox and decisions run the normal finalize
//     hook (balance conversion + LEAVE attendance rows);
//   * the overlap guard (PENDING/APPROVED) and the policy gates apply too.
// "leave.requested" is still emitted to the tenant's webhook endpoints.
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { isoDate } from "@/hrm-server/validation"
import { leaveDaysBetween, resolveWeeklyOffDays } from "@/hrm-server/utils"
import { spendableDays, leaveYearOf, proRatedEntitlement } from "@/hrm-server/leave-math"
import { getSettings } from "@/hrm-server/settings"
import { webhookEmit } from "@/hrm-server/webhooks"
import { authenticateRequest, apiOk, apiErr, readJsonBody, zodFail, auditApiRequest } from "../_auth"

export const dynamic = "force-dynamic"

const createSchema = z.object({
  employeeId: z.string().min(1),
  typeCode: z.string().trim().min(1).max(20),
  startDate: isoDate,
  endDate: isoDate,
  reason: z.string().max(500).optional(),
}).strict()

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req, "leave:write")
  if (!auth.ok) return auth.res
  const { key, ip } = auth

  const body = await readJsonBody(req)
  if (!body.ok) return body.res
  const parsed = createSchema.safeParse(body.body)
  if (!parsed.success) return zodFail(parsed.error.issues)
  const p = parsed.data

  if (p.startDate > p.endDate) {
    return apiErr(400, "VALIDATION", "`startDate` must not be after `endDate`")
  }

  // vendor-scoped employee (same status gate as the internal apply path)
  const emp = await db.employee.findFirst({
    where: { id: p.employeeId, vendorId: key.vendorId },
    select: { id: true, code: true, fullName: true, status: true, joiningDate: true, weeklyOff: true, shiftId: true, branchId: true, gender: true },
  })
  if (!emp) return apiErr(404, "NOT_FOUND", "Employee not found in this workspace")
  if (!["ACTIVE", "PROBATION", "ON_LEAVE"].includes(emp.status)) {
    return apiErr(400, "VALIDATION", `Cannot file leave while employee status is ${emp.status}`)
  }

  // vendor-scoped leave type by CODE (codes are stored uppercase)
  const type = await db.leaveType.findFirst({ where: { vendorId: key.vendorId, code: p.typeCode.toUpperCase() } })
  if (!type) {
    return apiErr(404, "NOT_FOUND", `Leave type "${p.typeCode}" not found in this workspace`)
  }
  if (emp.status === "PROBATION" && !type.probationEligible) {
    return apiErr(400, "VALIDATION", `${type.name} leave is not available during probation`)
  }
  const settings = await getSettings(key.vendorId)
  // ---- LVE-108 — the remaining policy gates the in-app path enforces ----
  // (the file header claimed parity while skipping these four)
  if (type.genderRestriction && type.genderRestriction !== emp.gender) {
    return apiErr(400, "VALIDATION", `${type.name} is only available to ${type.genderRestriction === "FEMALE" ? "female" : "male"} employees`)
  }
  const todayIso = new Date().toISOString().slice(0, 10)
  if (emp.joiningDate && type.waitingPeriodDays > 0) {
    const servedDays = Math.floor((Date.parse(todayIso) - Date.parse(emp.joiningDate)) / 86400000)
    if (servedDays < type.waitingPeriodDays) {
      return apiErr(400, "VALIDATION", `${type.name} requires ${type.waitingPeriodDays} day(s) of service (served: ${Math.max(0, servedDays)})`)
    }
  }
  const maxBackdate = Math.max(0, Number(settings.leave.maxBackdateDays) || 0)
  if (settings.leave.allowBackdated && p.startDate < new Date(Date.now() - maxBackdate * 86400000).toISOString().slice(0, 10)) {
    return apiErr(400, "VALIDATION", `Backdated leave is allowed only ${maxBackdate} day(s) back by this workspace's settings`)
  }
  if (!settings.leave.allowBackdated && p.startDate < todayIso) {
    return apiErr(400, "VALIDATION", "Backdated leave is not allowed by this workspace's settings")
  }

  // LVE-013 — authoritative working-day count, same math as leaveRequests.apply:
  // canonical weekly-off precedence + the countHolidaysAsLeave policy.
  const empShift = emp.shiftId ? await db.shift.findFirst({ where: { id: emp.shiftId, vendorId: key.vendorId }, select: { weeklyOff: true } }) : null
  const weeklyOff = resolveWeeklyOffDays(emp.weeklyOff, empShift?.weeklyOff, settings.general.weeklyHoliday)
  let holidaysInSpan: string[] = []
  if (!settings.leave.countHolidaysAsLeave) {
    const rows = await db.holiday.findMany({
      where: {
        vendorId: key.vendorId, type: { in: ["PUBLIC", "COMPANY"] },
        date: { gte: p.startDate, lte: p.endDate },
        OR: [{ branchId: null }, ...(emp.branchId ? [{ branchId: emp.branchId }] : [])],
      },
      select: { date: true },
    })
    holidaysInSpan = rows.map((r) => r.date)
  }
  const days = leaveDaysBetween(p.startDate, p.endDate, weeklyOff, holidaysInSpan)
  if (days <= 0) {
    return apiErr(400, "VALIDATION", "The requested period has zero working days under this workspace's weekly-off and holiday policy")
  }
  // LVE-108 — the probation per-request day cap (same computed-count basis as
  // the in-app path)
  {
    const cap = Math.max(0, Number(settings.leave.probationMaxDays) || 0)
    if (emp.status === "PROBATION" && cap > 0 && days > cap) {
      return apiErr(400, "VALIDATION", `Probation employees may take at most ${cap} day(s) per request (Settings → Leave) — split the request or complete probation first`)
    }
  }
  // LVE-108 — the optional-holiday yearly limit
  {
    const optionalLimit = Number(settings.leave.optionalHolidayLimit ?? 0)
    if (optionalLimit > 0) {
      const optYear = String(p.startDate.slice(0, 4))
      const yearHolidays = await db.holiday.findMany({ where: { vendorId: key.vendorId, type: "OPTIONAL", date: { gte: `${optYear}-01-01`, lte: `${optYear}-12-31` } }, select: { date: true } })
      const optDates = new Set(yearHolidays.map((h) => h.date))
      let n = 0
      for (let d = p.startDate; d <= p.endDate && n <= optionalLimit; d = new Date(Date.parse(d + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)) {
        if (optDates.has(d)) n++
      }
      if (n > 0) {
        const prior = await db.leaveRequest.findMany({ where: { vendorId: key.vendorId, employeeId: emp.id, status: "APPROVED", toDate: { gte: p.startDate } } })
        let used = 0
        for (const r of prior) for (let d = r.fromDate; d <= r.toDate; d = new Date(Date.parse(d + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)) if (optDates.has(d)) used++
        if (used + n > optionalLimit) {
          return apiErr(400, "VALIDATION", `Optional-holiday limit reached: ${used} of ${optionalLimit} already used this year; this request adds ${n}`)
        }
      }
    }
  }

  // LVE-004 parity — overlap guard including APPROVED requests
  const overlap = await db.leaveRequest.findFirst({
    where: { vendorId: key.vendorId, employeeId: emp.id, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: p.endDate }, toDate: { gte: p.startDate } },
  })
  if (overlap) {
    return apiErr(409, "CONFLICT", `An ${overlap.status === "PENDING" ? "pending" : "approved"} leave request (${overlap.fromDate} → ${overlap.toDate}) already overlaps these dates`)
  }

  // balance row (lazily created) + H-9-style reservation inside a transaction
  // LVE-104 — fiscal leave-year keying (same row the in-app path charges);
  // LVE-106 — PRO_RATA types open at the joining-date-prorated quota
  const monthsOfYear = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const fyStartMonth = Math.max(0, monthsOfYear.indexOf(settings.general.fiscalYearStart || "July"))
  const year = leaveYearOf(p.startDate, fyStartMonth)
  let bal = await db.leaveBalance.findFirst({ where: { employeeId: emp.id, leaveTypeId: type.id, year } })
  if (!bal) {
    try {
      const openingEntitled = (type.accrualFrequency === "PRO_RATA" && emp.joiningDate)
        ? proRatedEntitlement(type.defaultDays, emp.joiningDate, year, fyStartMonth, p.startDate)
        : type.defaultDays
      bal = await db.leaveBalance.create({ data: { vendorId: key.vendorId, employeeId: emp.id, leaveTypeId: type.id, year, entitled: openingEntitled } })
    } catch (e: any) {
      if (String(e?.code) !== "P2002") throw e
      bal = await db.leaveBalance.findFirst({ where: { employeeId: emp.id, leaveTypeId: type.id, year } })
    }
  }
  if (!bal) return apiErr(500, "INTERNAL", "Could not initialize the leave balance for this year")

  const { createApprovalRequest, announceApprovalRequest } = await import("@/hrm-server/approval")
  // synthetic system ctx: vendor-scoped, HR_ADMIN scope so the approval engine
  // resolves the standard LEAVE workflow; requestedBy is recorded as the API.
  const sysCtx: any = {
    userId: null, userName: `Public API (${key.name || key.id.slice(0, 8)})`,
    vendorId: key.vendorId, role: "HR_ADMIN", permissions: new Set(["*"]), ip,
  }

  let rec
  try {
    // TS narrowing cannot see the null-guard across the closure — pin the id
    const balId = bal.id
    rec = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "LeaveBalance" WHERE "id" = ${balId} FOR UPDATE`
      const locked = await tx.leaveBalance.findUnique({ where: { id: balId } })
      // LVE-002 (R3-4) — canonical spendable formula: carried-forward days
      // are spendable from the public API exactly like the in-app path;
      // LVE-105 — honoring the type's carry-expiry window
      const remaining = spendableDays(locked, {
        asOf: p.startDate,
        fyStartMonth,
        carryForwardExpiryMonths: type.carryForwardExpiryMonths,
      })
      if (type.paid && days > remaining) {
        throw Object.assign(new Error(`Insufficient balance: ${remaining} day(s) remaining of ${type.name}`), { apiStatus: 400, apiCode: "VALIDATION" })
      }
      const created = await tx.leaveRequest.create({
        data: {
          vendorId: key.vendorId,
          employeeId: emp.id,
          leaveTypeId: type.id,
          fromDate: p.startDate,
          toDate: p.endDate,
          days,
          reason: p.reason?.trim() || null,
          status: "PENDING",
          contactNumber: null,
          substituteStatus: null,
        },
      })
      await tx.leaveBalance.update({ where: { id: balId }, data: { pending: { increment: days } } })
      const sub = await createApprovalRequest(sysCtx, "LEAVE", "LeaveRequest", created.id,
        `${emp.fullName} — ${type.name} (${days}d, via API)`, { employeeId: emp.id, amount: days, leaveTypeId: type.id, source: "api" }, tx)
      await tx.leaveRequest.update({ where: { id: created.id }, data: { approvalRequestId: sub.id } })
      return { ...created, approvalRequestId: sub.id, restSeq: sub.restSeq }
    })
  } catch (e: any) {
    if (e?.apiStatus) return apiErr(e.apiStatus, e.apiCode, e.message)
    console.error("[api/v1/leave-requests] create failed", e)
    return apiErr(500, "INTERNAL", "The leave request could not be filed")
  }

  // post-commit side effects (never inside the transaction — H-14 discipline)
  await announceApprovalRequest(sysCtx, "LEAVE", "LeaveRequest", rec.id, rec.approvalRequestId, rec.restSeq,
    `${emp.fullName} — ${type.name} (${days}d, via API)`, { employeeId: emp.id, amount: days, leaveTypeId: type.id, source: "api" }).catch(() => {})

  // fire the tenant webhook event (never throws — failures are delivery rows)
  try {
    await webhookEmit(key.vendorId, "leave.requested", {
      requestId: rec.id,
      employeeId: emp.id,
      employeeCode: emp.code,
      typeCode: type.code,
      typeName: type.name,
      startDate: rec.fromDate,
      endDate: rec.toDate,
      days: rec.days,
      source: "api",
    })
  } catch { /* webhookEmit is never-throw; belt and braces */ }

  await auditApiRequest(key, ip, "Leave", rec.id, `POST /api/v1/leave-requests — ${emp.code} ${type.code} ${p.startDate}→${p.endDate} (${days} day${days === 1 ? "" : "s"}, submitted to the LEAVE approval workflow)`)
  return apiOk({
    id: rec.id,
    employeeId: emp.id,
    employeeCode: emp.code,
    employeeName: emp.fullName,
    typeCode: type.code,
    typeName: type.name,
    startDate: rec.fromDate,
    endDate: rec.toDate,
    days: rec.days,
    reason: rec.reason,
    status: rec.status,
    approvalRequestId: rec.approvalRequestId,
    createdAt: rec.createdAt,
    note: "Filed via the public API and submitted to this workspace's LEAVE approval workflow — the balance is reserved as pending and approvers act on it from the Approval Queue like any in-app request.",
  })
}

// ============ GET /api/v1/leave-balances — public REST API (leave:read) =====
// Leave balances per employee for the CURRENT cycle (deployment-zone year).
// Plain aggregation over the LeaveBalance model (entitled / used / pending /
// carriedForward per employee × leave type + remaining), joined with the
// LeaveType catalog and employee reference — deliberately NOT the full
// accrual/encashment engine. Optional employeeId filter; page/pageSize 1..100.
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { today } from "@/hrm-server/utils"
import { authenticateRequest, apiOk, auditApiRequest } from "../_auth"
import { parseListParams, etagFor, ifNoneMatchSatisfied, withETag, notModified } from "../_page"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req, "leave:read")
  if (!auth.ok) return auth.res
  const { key, ip } = auth

  const employeeId = req.nextUrl.searchParams.get("employeeId") || undefined
  const params = parseListParams(req)
  const { page, pageSize } = params
  const year = Number(today().slice(0, 4)) // business-year in the deployment zone

  const where: Record<string, unknown> = {
    vendorId: key.vendorId,
    year,
    ...(employeeId ? { employeeId } : {}),
  }
  // SEC-01 (R5) — user tokens carry the manager's org scope (API keys stay
  // tenant-wide by design). LeaveBalance is per-employee, so the scope
  // resolves to the manager's employee set.
  if (!employeeId && key.userScope?.role === "BRANCH_MANAGER" && key.userScope.branchId) {
    const mine = await db.employee.findMany({ where: { vendorId: key.vendorId, branchId: key.userScope.branchId }, select: { id: true } })
    where.employeeId = { in: mine.map((e) => e.id) }
  } else if (!employeeId && key.userScope?.role === "DEPT_MANAGER" && key.userScope.departmentId) {
    const mine = await db.employee.findMany({ where: { vendorId: key.vendorId, departmentId: key.userScope.departmentId }, select: { id: true } })
    where.employeeId = { in: mine.map((e) => e.id) }
  }
  // MOB-6 (Phase 3 WS-D) — delta sync + ETag on the balance snapshot
  if (params.updatedSince) where.updatedAt = { gte: params.updatedSince }
  const [rows, total, types, employees] = await Promise.all([
    db.leaveBalance.findMany({
      where,
      orderBy: [{ employeeId: "asc" }, { leaveTypeId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.leaveBalance.count({ where }),
    db.leaveType.findMany({ where: { vendorId: key.vendorId }, select: { id: true, code: true, name: true, paid: true } }),
    db.employee.findMany({ where: { vendorId: key.vendorId }, select: { id: true, code: true, fullName: true } }),
  ])

  await auditApiRequest(key, ip, "Leave", null, "GET /api/v1/leave-balances")
  const etag = etagFor({ year, employeeId: employeeId ?? null, count: rows.length, total })
  if (ifNoneMatchSatisfied(req, etag)) return notModified(etag)
  return withETag(apiOk(
    rows.map((b) => {
      const type = types.find((t) => t.id === b.leaveTypeId)
      const emp = employees.find((e) => e.id === b.employeeId)
      return {
        employeeId: b.employeeId,
        employeeCode: emp?.code ?? null,
        employeeName: emp?.fullName ?? null,
        leaveTypeId: b.leaveTypeId,
        typeCode: type?.code ?? null,
        typeName: type?.name ?? null,
        paid: type?.paid ?? null,
        year: b.year,
        entitled: b.entitled,
        used: b.used,
        pending: b.pending,
        carriedForward: b.carriedForward,
        remaining: b.entitled - b.used - b.pending,
      }
    }),
    { page, pageSize, total, year, ...(params.updatedSince ? { updatedSince: params.updatedSince.toISOString() } : {}) },
  ), etag)
}

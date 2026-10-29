// ============ GET /api/v1/employees — public REST API (scope employees:read) =
// Paginated employee directory. Two pagination modes:
//   * page/pageSize (1..100) — the original contract, unchanged.
//   * ?cursor=… — MOB-2/3 (Phase 3 WS-D): stable (createdAt, id) keyset
//     pagination with nextCursor/hasMore (deep pages never re-scan offsets).
//   * ?updatedSince=ISO — MOB-6: delta sync filter on updatedAt.
//   * ETag / If-None-Match — MOB-6: cheap 304s for unchanged pages.
// Field policy: a directory-level subset — identity, org placement and
// employment facts. Deep PII (addresses, family, tax profile, payout data)
// and binary payloads (photos/documents) are NOT exposed on this surface.
// MOB-5 (Phase 3 WS-D): org decoration (branch/department/designation/manager
// names) resolves ONLY the ids present on the current page — the whole-org
// id/name loads were O(org size) per request on every list call.
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { EMPLOYEE_STATUSES } from "@/hrm-server/types"
import { authenticateRequest, apiOk, apiErr, auditApiRequest } from "../_auth"
import { parseListParams, decodeCursor, encodeCursor, keysetWhere, etagFor, ifNoneMatchSatisfied, withETag, notModified } from "../_page"

export const dynamic = "force-dynamic"

const EMPLOYEE_API_SELECT = {
  id: true, code: true, fullName: true, nameBn: true, preferredName: true,
  gender: true, bloodGroup: true, maritalStatus: true, nationality: true, religion: true,
  dob: true, mobile: true, altMobile: true, officialEmail: true, personalEmail: true,
  branchId: true, departmentId: true, designationId: true, reportingManagerId: true,
  workLocation: true, joiningDate: true, confirmationDate: true, probationMonths: true,
  employmentType: true, status: true, category: true, grade: true,
  createdAt: true, updatedAt: true,
} as const

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req, "employees:read")
  if (!auth.ok) return auth.res
  const { key, ip } = auth

  const status = req.nextUrl.searchParams.get("status")
  if (status && !EMPLOYEE_STATUSES.includes(status as (typeof EMPLOYEE_STATUSES)[number])) {
    return apiErr(400, "VALIDATION", `Invalid status filter "${status}" — allowed: ${EMPLOYEE_STATUSES.join(", ")}`)
  }
  const params = parseListParams(req)
  const where: Record<string, unknown> = { vendorId: key.vendorId }
  // SEC-01 (R5) — user tokens carry the manager's org scope (API keys stay
  // tenant-wide by design); mirrors the in-app employeeScopeFilter.
  if (key.userScope?.role === "BRANCH_MANAGER" && key.userScope.branchId) where.branchId = key.userScope.branchId
  if (key.userScope?.role === "DEPT_MANAGER" && key.userScope.departmentId) where.departmentId = key.userScope.departmentId
  if (status) where.status = status
  if (params.updatedSince) where.updatedAt = { gte: params.updatedSince }
  if (params.cursorMode) Object.assign(where, keysetWhere(decodeCursor(params.cursor) || { c: "9999-12-31T23:59:59.999Z", id: "~" }))

  const [rows, total] = await Promise.all([
    db.employee.findMany({
      where: where as any,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: EMPLOYEE_API_SELECT,
      ...(params.cursorMode
        ? { take: params.pageSize + 1 } // +1 → hasMore detection
        : { skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    }),
    // total stays meaningful in page mode; in cursor mode it answers "how many
    // rows remain under the current filters" (delta clients use it for progress)
    db.employee.count({ where: where as any }),
  ])
  const hasMore = params.cursorMode && rows.length > params.pageSize
  const pageRows = hasMore ? rows.slice(0, params.pageSize) : rows

  // MOB-5 — page-scoped decoration: resolve ONLY the ids on this page
  const branchIds = [...new Set(pageRows.map((r) => r.branchId).filter((v): v is string => !!v))]
  const deptIds = [...new Set(pageRows.map((r) => r.departmentId).filter((v): v is string => !!v))]
  const desigIds = [...new Set(pageRows.map((r) => r.designationId).filter((v): v is string => !!v))]
  const managerIds = [...new Set(pageRows.map((r) => r.reportingManagerId).filter((v): v is string => !!v))]
  const [branches, depts, desigs, managers] = await Promise.all([
    branchIds.length ? db.branch.findMany({ where: { vendorId: key.vendorId, id: { in: branchIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    deptIds.length ? db.department.findMany({ where: { vendorId: key.vendorId, id: { in: deptIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    desigIds.length ? db.designation.findMany({ where: { vendorId: key.vendorId, id: { in: desigIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    managerIds.length ? db.employee.findMany({ where: { vendorId: key.vendorId, id: { in: managerIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
  ])

  const payload = pageRows.map((e) => ({
    ...e,
    branchName: branches.find((b) => b.id === e.branchId)?.name ?? null,
    departmentName: depts.find((d) => d.id === e.departmentId)?.name ?? null,
    designationName: desigs.find((d) => d.id === e.designationId)?.name ?? null,
    reportingManagerName: managers.find((m) => m.id === e.reportingManagerId)?.fullName ?? null,
  }))

  await auditApiRequest(key, ip, "Employee", null, "GET /api/v1/employees")

  // MOB-6 — ETag / If-None-Match
  const etag = etagFor({ rows: payload, total, v: params.cursor })
  if (ifNoneMatchSatisfied(req, etag)) return notModified(etag)

  const meta: Record<string, unknown> = { page: params.page, pageSize: params.pageSize, total }
  if (params.updatedSince) meta.updatedSince = params.updatedSince.toISOString()
  if (params.cursorMode) {
    meta.cursor = params.cursor
    meta.hasMore = hasMore
    meta.nextCursor = hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null
  }
  return withETag(apiOk(payload, meta), etag)
}

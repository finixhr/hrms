// ============ /api/v1/attendance — public REST API ==========================
// GET  (scope attendance:read)  — attendance records for a from/to ISO date
//        range (employeeId optional). Pagination modes (MOB-2/3, Phase 3
//        WS-D): the ORIGINAL page/pageSize contract (unchanged, still capped
//        at 500 rows per call) PLUS ?cursor=… keyset pagination over
//        (date, createdAt, id) with nextCursor/hasMore — the old behavior
//        silently hard-truncated at 500 rows and its `truncated` flag only
//        said "this page is full", never "there is more"; the cursor mode
//        walks the ENTIRE range in bounded pages. ?updatedSince=ISO filters
//        updatedAt (delta sync) and ETag/If-None-Match gives cheap 304s.
// POST (scope attendance:write) — push one attendance punch { employeeId,
//        timestamp ISO, direction IN|OUT }. Writes through the SAME
//        Attendance model + field conventions as the internal marking path
//        (routes/attendance.ts upsertAttendance / zkteco processor):
//        vendor-scoped employee lookup, roster-resolved shift, shift-aware
//        late/early/OT computation via the shared computeAttendance engine,
//        atomic upsert on the (vendorId, employeeId, date) unique key.
//        source is "API"; the device linkage columns (deviceInfo/ip) carry
//        the API provenance. Human decisions stay protected: a MANUAL row or
//        a LEAVE/HOLIDAY/WEEKLY_OFF/WFH/BUSINESS_TRIP day is never silently
//        overwritten (§39 protection). No webhook is emitted for API pushes.
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { computeAttendance } from "@/hrm-server/routes/attendance"
import { getSettings } from "@/hrm-server/settings"
import { zonedParts } from "@/hrm-server/utils"
import { authenticateRequest, apiOk, apiErr, readJsonBody, zodFail, auditApiRequest } from "../_auth"
import { parseListParams, etagFor, ifNoneMatchSatisfied, withETag, notModified } from "../_page"

export const dynamic = "force-dynamic"

const ATTENDANCE_API_SELECT = {
  id: true, employeeId: true, date: true, shiftId: true,
  checkIn: true, checkOut: true,
  workingMinutes: true, lateMinutes: true, earlyLeaveMinutes: true, overtimeMinutes: true,
  status: true, source: true, otApproved: true,
  createdAt: true, updatedAt: true,
} as const

/** Rows the §39 protection never lets an API push overwrite. */
const PROTECTED_STATUSES = ["LEAVE", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP"]

const PAGE_ROW_CAP = 500

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req, "attendance:read")
  if (!auth.ok) return auth.res
  const { key, ip } = auth

  const from = req.nextUrl.searchParams.get("from") || ""
  const to = req.nextUrl.searchParams.get("to") || ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return apiErr(400, "VALIDATION", "Query parameters from and to are required ISO dates (YYYY-MM-DD)")
  }
  if (from > to) return apiErr(400, "VALIDATION", "`from` must not be after `to`")
  const employeeId = req.nextUrl.searchParams.get("employeeId") || undefined
  const params = parseListParams(req)

  const where: Record<string, unknown> = {
    vendorId: key.vendorId,
    date: { gte: from, lte: to },
    ...(employeeId ? { employeeId } : {}),
  }
  // SEC-01 (R5) — user tokens carry the manager's org scope (API keys stay
  // tenant-wide by design); mirrors the in-app employeeScopeFilter. Attendance
  // is a per-employee table, so the scope resolves to the manager's employee set.
  if (!employeeId && key.userScope?.role === "BRANCH_MANAGER" && key.userScope.branchId) {
    const mine = await db.employee.findMany({ where: { vendorId: key.vendorId, branchId: key.userScope.branchId }, select: { id: true } })
    where.employeeId = { in: mine.map((e) => e.id) }
  } else if (!employeeId && key.userScope?.role === "DEPT_MANAGER" && key.userScope.departmentId) {
    const mine = await db.employee.findMany({ where: { vendorId: key.vendorId, departmentId: key.userScope.departmentId }, select: { id: true } })
    where.employeeId = { in: mine.map((e) => e.id) }
  }
  if (params.updatedSince) where.updatedAt = { gte: params.updatedSince }

  // cursor mode: keyset over (date desc, createdAt desc, id desc)
  let cursorFilter: Record<string, unknown> | null = null
  if (params.cursor) {
    try {
      const v = JSON.parse(Buffer.from(params.cursor, "base64").toString("utf8"))
      if (typeof v?.d === "string" && typeof v?.c === "string" && typeof v?.id === "string") {
        cursorFilter = {
          OR: [
            { date: { lt: v.d } },
            { date: v.d, createdAt: { lt: v.c } },
            { date: v.d, createdAt: v.c, id: { lt: v.id } },
          ],
        }
      }
    } catch { /* malformed cursor → fresh first page */ }
  }
  if (cursorFilter) Object.assign(where, cursorFilter)

  const take = params.cursorMode ? params.pageSize + 1 : Math.min(params.pageSize, PAGE_ROW_CAP)
  const rows = await db.attendance.findMany({
    where: where as any,
    orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: ATTENDANCE_API_SELECT,
    take,
  })
  const hasMore = params.cursorMode && rows.length > params.pageSize
  const pageRows = hasMore ? rows.slice(0, params.pageSize) : rows
  const emps = pageRows.length
    ? await db.employee.findMany({ where: { vendorId: key.vendorId, id: { in: [...new Set(pageRows.map((r) => r.employeeId))] } }, select: { id: true, code: true, fullName: true } })
    : []

  await auditApiRequest(key, ip, "Attendance", null, "GET /api/v1/attendance")

  const payload = pageRows.map((r) => ({
    ...r,
    employeeCode: emps.find((e) => e.id === r.employeeId)?.code ?? null,
    employeeName: emps.find((e) => e.id === r.employeeId)?.fullName ?? null,
  }))

  // MOB-6 — ETag / If-None-Match
  const etag = etagFor({ rows: payload, from, to, cursor: params.cursor })
  if (ifNoneMatchSatisfied(req, etag)) return notModified(etag)

  const meta: Record<string, unknown> = {
    from, to, employeeId: employeeId ?? null,
    count: pageRows.length,
    // MOB-2 — the flag now tells the truth in BOTH modes: page mode caps at
    // PAGE_ROW_CAP (a full cap page means more may exist — page the range
    // narrower or switch to ?cursor=); cursor mode reports hasMore exactly.
    truncated: !params.cursorMode && pageRows.length === PAGE_ROW_CAP,
  }
  if (params.updatedSince) meta.updatedSince = params.updatedSince.toISOString()
  if (params.cursorMode) {
    meta.cursor = params.cursor
    meta.hasMore = hasMore
    meta.nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ d: pageRows[pageRows.length - 1].date, c: pageRows[pageRows.length - 1].createdAt.toISOString(), id: pageRows[pageRows.length - 1].id })).toString("base64")
      : null
  }
  return withETag(apiOk(payload, meta), etag)
}

const pushSchema = z.object({
  employeeId: z.string().min(1),
  timestamp: z.string().min(10),
  direction: z.enum(["IN", "OUT"]),
  source: z.literal("API").optional(),
}).strict()

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req, "attendance:write")
  if (!auth.ok) return auth.res
  const { key, ip } = auth

  const body = await readJsonBody(req)
  if (!body.ok) return body.res
  const parsed = pushSchema.safeParse(body.body)
  if (!parsed.success) return zodFail(parsed.error.issues)
  const p = parsed.data

  const ts = Date.parse(p.timestamp)
  if (!Number.isFinite(ts)) {
    return apiErr(400, "VALIDATION", "`timestamp` must be an ISO 8601 datetime (e.g. 2026-10-08T09:05:00Z)")
  }
  // M-8/M-18 — business wall clock in the deployment zone (Asia/Dhaka default):
  // the punch's DATE and HH:MM belong to the tenant's business day, exactly
  // like device punches (zkteco/processor.ts attributeDate/eventClock).
  const parts = zonedParts(new Date(ts))
  const date = `${parts.y}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`
  const clock = `${parts.hh}:${parts.mm}`

  // vendor-scoped employee lookup (H-10 — same guard as upsertAttendance)
  const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: key.vendorId }, select: { id: true, code: true, fullName: true, shiftId: true } })
  if (!emp) return apiErr(404, "NOT_FOUND", "Employee not found in this workspace")

  const existing = await db.attendance.findFirst({ where: { vendorId: key.vendorId, employeeId: emp.id, date } })
  // §39 protection — human decisions win over machine punches
  if (existing && existing.source === "MANUAL") {
    return apiErr(400, "ATTENDANCE_PROTECTED", `A manual attendance record already exists for ${date} — use the attendance correction workflow instead`)
  }
  if (existing && PROTECTED_STATUSES.includes(existing.status)) {
    return apiErr(400, "ATTENDANCE_PROTECTED", `${date} is recorded as ${existing.status} — this day cannot be overwritten by an API punch`)
  }

  // roster-resolved shift (mirrors routes/attendance.ts resolveShift)
  const assignment = await db.shiftAssignment.findFirst({
    where: { vendorId: key.vendorId, employeeId: emp.id, fromDate: { lte: date }, OR: [{ toDate: null }, { toDate: { gte: date } }] },
    orderBy: { fromDate: "desc" },
  })
  const shiftId = assignment?.shiftId || emp.shiftId
  const shift = shiftId ? await db.shift.findFirst({ where: { id: shiftId } }) : null

  // earliest IN / latest OUT — same convention as the device rebuild path
  let checkIn: string | null = existing?.checkIn ?? null
  let checkOut: string | null = existing?.checkOut ?? null
  if (p.direction === "IN") checkIn = checkIn ? (checkIn < clock ? checkIn : clock) : clock
  if (p.direction === "OUT") checkOut = checkOut ? (checkOut > clock ? checkOut : clock) : clock
  if (!checkIn) {
    return apiErr(400, "VALIDATION", `No check-in exists for ${date} — push the IN punch first`)
  }

  // shift-aware computation via the shared engine. NOTE: unlike the manual
  // marking path, an open check-in is NOT auto-closed at shift end — the OUT
  // punch must arrive as its own API call.
  const settings = await getSettings(key.vendorId)
  const calc = computeAttendance(shift, checkIn, checkOut, settings.attendance.halfDayHours, {
    graceMinutes: settings.latePolicy?.graceMinutes,
    earlyLeaveThresholdMinutes: settings.earlyLeavePolicy?.thresholdMinutes,
  })

  const data = {
    vendorId: key.vendorId,
    employeeId: emp.id,
    date,
    shiftId: shift?.id || null,
    checkIn,
    checkOut,
    workingMinutes: calc.workingMinutes,
    lateMinutes: calc.lateMinutes,
    earlyLeaveMinutes: calc.earlyLeaveMinutes,
    overtimeMinutes: calc.overtimeMinutes,
    status: calc.status,
    source: "API",
    deviceInfo: "Public API v1",
    ip: ip ?? undefined,
    remarks: `Public API v1 push (${p.direction} ${p.timestamp})`,
  }
  const { vendorId: _v, employeeId: _e, date: _d, ...updateData } = data
  // atomic upsert on the compound unique key (HIGH-8 pattern)
  const rec = await db.attendance.upsert({
    where: { vendorId_employeeId_date: { vendorId: key.vendorId, employeeId: emp.id, date } },
    create: data,
    update: updateData,
  })

  await auditApiRequest(key, ip, "Attendance", rec.id, `POST /api/v1/attendance — ${p.direction} punch for ${emp.code} on ${date} (${rec.status})`)
  return apiOk({
    ...rec,
    employeeCode: emp.code,
    employeeName: emp.fullName,
    punch: { direction: p.direction, timestamp: p.timestamp, date, time: clock },
  })
}

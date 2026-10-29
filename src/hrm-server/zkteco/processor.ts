// ============ Attendance event processor (spec §11–§14, §23–§25, §39) ============
// RAW DEVICE EVENT  →  HRM ATTENDANCE RESULT.  Fully deterministic and
// re-runnable: a day's attendance row is always REBUILT from the complete set
// of stored raw events for that (employee, date) — reprocessing can never
// create duplicates and rule changes can be recalculated without touching the
// immutable raw layer.
//
// Layer contract (spec §44): input = normalized raw events from the adapter,
// output = existing Attendance rows. No ADMS/protocol knowledge here.

import { db } from "@/lib/db"
import { computeAttendance } from "../routes/attendance"
import { audit, notify } from "../audit"
import { getSettings } from "../settings"
import { timeToMinutes, addDays, titleCase, fromZonedWall } from "../utils"
import { calcOvernight } from "../overnight"
import { isInClass, eventDate, eventClock } from "./adapter"
import { GATEWAY_ENV } from "./gateway"

type RawEvent = {
  id: string
  vendorId: string
  deviceId: string
  deviceSerial: string
  deviceUserId: string
  employeeId: string | null
  eventTime: string
  verifyMode: number | null
  attendanceStatus: number | null
  workCode: string | null
  eventType: string
  rawLine: string
  processingStatus: string
  processingError: string | null
  retryCount: number
}

type ShiftLike = {
  id: string
  startTime: string
  endTime: string
  graceMinutes: number
  breakMinutes: number
  minWorkingHours: number
  otThresholdMinutes: number
} | null

// ---------- shift resolution (mirrors the HRM engine's roster logic) ----------
async function shiftFor(vendorId: string, employeeId: string, defaultShiftId: string | null, date: string): Promise<ShiftLike> {
  const assignment = await db.shiftAssignment.findFirst({
    where: { vendorId, employeeId, fromDate: { lte: date }, OR: [{ toDate: null }, { toDate: { gte: date } }] },
    orderBy: { fromDate: "desc" },
  })
  const shiftId = assignment?.shiftId || defaultShiftId
  if (!shiftId) return null
  const s = await db.shift.findFirst({ where: { id: shiftId } })
  return s ? {
    id: s.id, startTime: s.startTime, endTime: s.endTime, graceMinutes: s.graceMinutes,
    breakMinutes: s.breakMinutes, minWorkingHours: s.minWorkingHours, otThresholdMinutes: s.otThresholdMinutes,
  } : null
}

function isOvernight(shift: ShiftLike): boolean {
  if (!shift) return false
  return timeToMinutes(shift.endTime) <= timeToMinutes(shift.startTime)
}

/** Overnight shifts (§14): an OUT punch in the early morning belongs to the
 *  shift that started the previous evening — never stamp it as "current day". */
async function attributeDate(ev: { eventTime: string; eventType: string }, vendorId: string, employeeId: string, defaultShiftId: string | null, precomputedPrevShift?: ShiftLike | null): Promise<string> {
  const date = eventDate(ev.eventTime)
  if (isInClass(ev.eventType as any)) return date
  const prev = addDays(date, -1)
  // SCL-9 (Phase 2 WS2) — the previous-day shift is identical for every
  // event of one (employee, day) rebuild; rebuildDaily computes it ONCE and
  // passes it through (the old code re-queried shiftAssignment+shift PER
  // EVENT — 2 queries × every punch of the day, the core of the O(N²)
  // rebuild).
  const prevShift = precomputedPrevShift !== undefined ? precomputedPrevShift : await shiftFor(vendorId, employeeId, defaultShiftId, prev)
  if (!isOvernight(prevShift)) return date
  const clock = timeToMinutes(eventClock(ev.eventTime))
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
  const end = timeToMinutes(prevShift!.endTime)
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
  const start = timeToMinutes(prevShift!.startTime)
  // early-morning window before the overnight shift ends (and before its start, i.e. next-day side)
  if (clock < end && clock < start) return prev
  return date
}

// ---------- overnight-aware calculation (extends the existing engine) ----------
// ATT-003 — the local copy is RETIRED: the shared ../overnight engine now
// takes the same vendor policy bundle the day branch applies (grace,
// early-leave threshold, statutory daily OT cap), so the device path and
// every portal path hold night-shift employees to the SAME rules. The
// signature is compatible (policy is optional).

// ---------- deterministic daily rebuild (spec §13, §24) ----------
/** Rebuild the Attendance row for (employee, date) from ALL raw device events
 *  attributed to that date. Idempotent by construction. */
export async function rebuildDaily(vendorId: string, employeeId: string, date: string): Promise<{ touched: boolean; protected: boolean; status?: string }> {
  const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId } })
  if (!emp) return { touched: false, protected: false }
  const shift = await shiftFor(vendorId, employeeId, emp.shiftId, date)

  // raw events for the day ±1 (overnight attribution window)
  const dayEvents = await db.attendanceRawEvent.findMany({
    where: { vendorId, employeeId, eventTime: { gte: addDays(date, -1), lt: addDays(date, 2) } },
    orderBy: { eventTime: "asc" },
  })
  // SCL-9 — one shared prev-day shift lookup for the whole rebuild (the
  // attribution window spans at most two dates, and every event of the day
  // attributes against the SAME previous-day shift).
  const prevShiftShared = await shiftFor(vendorId, employeeId, emp.shiftId, addDays(date, -1))
  const attributed: RawEvent[] = []
  for (const ev of dayEvents) {
    const d = await attributeDate(ev, vendorId, employeeId, emp.shiftId, prevShiftShared)
    if (d === date) attributed.push(ev as unknown as RawEvent)
  }

  // ---- punch direction ----
  // 2026-10-07 — many terminals (the live SenseFace 3A among them) are not
  // configured with punch-state keys and stamp EVERY punch with status 0
  // ("Check-In"), or 254/255 (AUTO). Trusting that code made every punch a
  // check-in, so check-out was never recorded. Rule:
  //   · the day contains an explicit OUT-class punch (status 1/2/5) → the
  //     device really uses state keys → honour the states;
  //   · otherwise (only status-0 and/or AUTO punches) → punch ORDER decides:
  //     first punch of the day = check-in, last punch = check-out (a re-scan
  //     within 2 minutes of the first punch is not a check-out).
  const sorted = attributed.slice().sort((a, b) => a.eventTime.localeCompare(b.eventTime))
  const inTimes: string[] = []
  const outTimes: string[] = []
  const seen = new Set<string>()
  const unique: RawEvent[] = []
  for (const ev of sorted) {
    const key = `${ev.deviceId}|${ev.eventTime}|${ev.eventType}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(ev)
  }
  const usesStates = unique.some((ev) => ev.eventType !== "AUTO" && !isInClass(ev.eventType as any))
  let firstLastOut: string | null = null
  if (usesStates) {
    for (const ev of unique) {
      const t = eventClock(ev.eventTime)
      if (ev.eventType === "AUTO" || isInClass(ev.eventType as any)) inTimes.push(t)
      else outTimes.push(t)
    }
  } else if (unique.length) {
    const first = unique[0]
    const last = unique[unique.length - 1]
    inTimes.push(eventClock(first.eventTime))
    const gapMs = new Date(last.eventTime.replace(" ", "T") + "Z").getTime() - new Date(first.eventTime.replace(" ", "T") + "Z").getTime()
    if (unique.length > 1 && gapMs >= 2 * 60_000) {
      outTimes.push(eventClock(last.eventTime))
      firstLastOut = last.id
    }
  }

  const existing = await db.attendance.findFirst({ where: { vendorId, employeeId, date } })

  // protection (§39): human decisions win over device punches — never overwrite
  if (existing && existing.source === "MANUAL") {
    await db.attendanceRawEvent.updateMany({
      where: { id: { in: attributed.map((e) => e.id) }, processingStatus: { in: ["RECEIVED", "UNKNOWN_EMPLOYEE", "FAILED"] } },
      data: { processingStatus: "SKIPPED_MANUAL", processedAt: new Date(), processingError: "Manual attendance record exists for this date" },
    })
    return { touched: false, protected: true }
  }
  if (existing && ["LEAVE", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP"].includes(existing.status)) {
    await db.attendanceRawEvent.updateMany({
      where: { id: { in: attributed.map((e) => e.id) }, processingStatus: { in: ["RECEIVED", "UNKNOWN_EMPLOYEE", "FAILED"] } },
      data: { processingStatus: "PROCESSED", processedAt: new Date(), processingError: null },
    })
    return { touched: false, protected: true, status: existing.status }
  }

  const checkIn = inTimes.length ? inTimes.reduce((a, b) => (a < b ? a : b)) : null
  const checkOut = outTimes.length ? outTimes.reduce((a, b) => (a > b ? a : b)) : null
  if (!checkIn && !existing) {
    // OUT-only punch with no prior check-in for the day → nothing computable yet
    await db.attendanceRawEvent.updateMany({
      where: { id: { in: attributed.map((e) => e.id) }, processingStatus: { in: ["RECEIVED", "UNKNOWN_EMPLOYEE", "FAILED"] } },
      data: { processingStatus: "PROCESSED", processedAt: new Date(), processingError: null },
    })
    return { touched: false, protected: false }
  }

  // HRM-008/009 — vendor late / early-leave policy applies to device punches too
  const vendorSettings = await getSettings(vendorId)
  // ATT-003/ATT-004 — the SAME policy bundle on BOTH branches (the overnight
  // call used to skip vendor grace/early-leave/OT-cap entirely), and the
  // half-day threshold reads the vendor setting instead of a hardcoded 4h.
  // ATT-017 (R7) — the bundle merges the employee's effective ATTENDANCE_RULES
  // policy over the tenant-wide settings (per-employee/group overrides).
  const { dayRulesBundle } = await import("../attendance-policy")
  const rules = await dayRulesBundle(vendorId, emp, vendorSettings)
  const policyBundle = {
    graceMinutes: rules.graceMinutes,
    earlyLeaveThresholdMinutes: rules.earlyLeaveThresholdMinutes,
    maxOtMinutesPerDay: rules.maxOtMinutesPerDay,
  }
  const calc = shift && isOvernight(shift) && checkIn && checkOut
    ? calcOvernight(shift, checkIn, checkOut, policyBundle)
    : computeAttendance(shift as any, checkIn, checkOut, vendorSettings.attendance?.halfDayHours ?? 4, policyBundle)

  const device = attributed.length
    ? await db.attendanceDevice.findFirst({ where: { id: attributed[attributed.length - 1].deviceId } })
    : null
  const deviceInfo = device ? `${device.name} (${device.deviceIdentifier || device.deviceId})` : "ADMS device"

  const data: any = {
    vendorId, employeeId, date, shiftId: shift?.id || null,
    checkIn: checkIn || existing?.checkIn || null,
    checkOut: checkOut || existing?.checkOut || null,
    workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
    earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes,
    status: calc.status, source: "BIOMETRIC", deviceInfo, remarks: "ADMS push (auto-computed)",
  }
  // ATT-004 — OT-approval discipline on the device rebuild path (the day-branch
  // portal paths already do this): when the vendor requires OT approval, a
  // rebuilt day with OT minutes starts UNAPPROVED — payroll must never treat
  // null otApproved as approved. On UPDATE the flag is preserved-but-grown:
  // an approved day stays approved, extra minutes merely ride the monthly cap
  // and the OT register; a rejected flag is never silently flipped.
  if (calc.overtimeMinutes > 0) {
    const approvalRequired = vendorSettings.shift?.otApprovalRequired
    if (!existing) {
      data.otApproved = approvalRequired ? false : null
    } else if (existing.otApproved !== true) {
      data.otApproved = approvalRequired ? false : existing.otApproved ?? null
    } else {
      data.otApproved = true // previously approved explicitly — preserved
    }
  }
  // 2026-10-07 — atomic upsert on the (vendorId, employeeId, date) unique
  // key. The live-push fast path and the background sweeper can rebuild the
  // SAME employee-day concurrently (two punches of one person in one batch,
  // or a historical re-upload); the old findFirst → create raced and failed
  // with a unique-constraint error, bouncing the event to FAILED/retry. The
  // rebuild is deterministic, so whichever writer lands last is correct.
  const { vendorId: _v, employeeId: _e, date: _d, ...updateData } = data
  const row = await db.attendance.upsert({
    where: { vendorId_employeeId_date: { vendorId, employeeId, date } },
    create: data,
    update: updateData,
  })
  const attendanceRowId: string = row.id

  // 2026-10 round §33 — provenance: project the normalized punch into the
  // AttendanceEvent layer (source ZKTECO, method DEVICE_PUNCH) and link the
  // raw events back to it, so every device punch remains traceable:
  // AttendanceRawEvent → AttendanceEvent → Attendance. Idempotent per raw
  // event (clientEventId = raw:{id}) — a reprocessed punch never duplicates.
  // SCL-9 (Phase 2 WS2) — the projection used to be 3 queries PER RAW EVENT
  // (findFirst existence + create + attendanceEventId update): a 20-punch day
  // cost 60 queries on EVERY rebuild. Now: 1 existence findMany (whereIn),
  // 1 createMany (skipDuplicates on unique(vendorId, clientEventId)),
  // 1 findMany for the new ids, and ONE unnest-based bulk UPDATE for the
  // back-links — the same work regardless of punch count.
  try {
    const clientIds = attributed.map((raw) => `raw:${raw.id}`)
    const existingEvents = clientIds.length
      ? await db.attendanceEvent.findMany({
          where: { vendorId, clientEventId: { in: clientIds } },
          select: { id: true, clientEventId: true, attendanceId: true },
        })
      : []
    const existingByClient = new Map(existingEvents.map((e) => [e.clientEventId as string, e]))
    // rare fix-up: a prior rebuild linked this raw event to a different
    // (older) attendance row — repoint it at the current day's row
    for (const e of existingEvents) {
      if (e.attendanceId !== attendanceRowId) {
        await db.attendanceEvent.update({ where: { id: e.id }, data: { attendanceId: attendanceRowId } }).catch(() => {})
      }
    }
    const missing = attributed.filter((raw) => !existingByClient.has(`raw:${raw.id}`))
    if (missing.length) {
      await db.attendanceEvent.createMany({
        data: missing.map((raw) => {
          // deterministic punch classification: IN-class punches drove check-in,
          // OUT-class drove check-out; AUTO punches keep the generic label (the
          // in/out toggle state was consumed during the sort pass above).
          // order-based days (device without state keys): the day's first punch
          // is the check-in, the current last punch the check-out
          const punchType = !usesStates
            ? (raw.id === unique[0]?.id ? "CHECK_IN" : raw.id === firstLastOut ? "CHECK_OUT" : "DEVICE_PUNCH")
            : isInClass(raw.eventType as any)
              ? "CHECK_IN"
              : raw.eventType === "AUTO" ? "DEVICE_PUNCH" : "CHECK_OUT"
          // server-side occurredAt from the raw device frame (eventDate + eventClock)
          // M-18 — the wall clock is parsed in the DEVICE'S timezone (the raw frame
          // the device stamped), then converted to the true instant. The old
          // server-local parse shifted every punch by the zone offset on UTC hosts
          // (a 09:00 Dhaka punch was recorded as 09:00 UTC = 15:00 Dhaka).
          const evDate = eventDate(raw.eventTime)
          const evClock = eventClock(raw.eventTime)
          const occurredAt = fromZonedWall(`${evDate}T${(evClock || "00:00").length === 5 ? evClock + ":00" : "00:00:00"}`)
          return {
            vendorId, employeeId,
            eventType: punchType,
            attendanceMethod: "DEVICE_PUNCH",
            source: "ZKTECO",
            occurredAt: Number.isFinite(occurredAt.getTime()) ? occurredAt : new Date(),
            clientTimestamp: raw.eventTime,
            deviceId: raw.deviceId,
            attendanceId: attendanceRowId,
            status: "ACCEPTED",
            reason: `ADMS punch (${raw.eventType}) via ${deviceInfo}`,
            flagsJson: JSON.stringify({ verifyMode: (raw as any).verifyMode, workCode: (raw as any).workCode }),
            clientEventId: `raw:${raw.id}`,
            rawEventId: raw.id,
          }
        }),
        skipDuplicates: true,
      })
      // bulk back-link AttendanceRawEvent.attendanceEventId (one UPDATE via
      // unnest — per-row values can't go through a single Prisma updateMany)
      const freshEvents = await db.attendanceEvent.findMany({
        where: { vendorId, clientEventId: { in: missing.map((raw) => `raw:${raw.id}`) } },
        select: { id: true, clientEventId: true },
      })
      const ridById = new Map(freshEvents.map((e) => [String(e.clientEventId).slice(4), e.id]))
      const ridArr: string[] = []
      const eidArr: string[] = []
      for (const raw of missing) {
        const eid = ridById.get(raw.id)
        if (eid) { ridArr.push(raw.id); eidArr.push(eid) }
      }
      if (ridArr.length) {
        await db.$executeRaw`UPDATE "AttendanceRawEvent" r
          SET "attendanceEventId" = v.eid
          FROM (SELECT * FROM unnest(${ridArr}::text[], ${eidArr}::text[]) AS t(rid, eid)) v
          WHERE r.id = v.rid`.catch(() => {})
      }
    }
  } catch (e) {
    // Event projection must never block the core attendance pipeline (§93
    // priority: existing ZKTeco reliability > new features) — log and move on.
    console.error("[zkteco] attendance-event projection failed", e)
  }

  await db.attendanceRawEvent.updateMany({
    where: { id: { in: attributed.map((e) => e.id) } },
    data: { processingStatus: "PROCESSED", processedAt: new Date(), processingError: null },
  })
  return { touched: true, protected: false, status: calc.status }
}

// ---------- single event processing (fast path + retries) ----------
export async function mapAndProcessEvent(ev: RawEvent): Promise<"PROCESSED" | "UNKNOWN_EMPLOYEE" | "FAILED" | "SKIPPED_MANUAL"> {
  try {
    let employeeId = ev.employeeId
    if (!employeeId) {
      let mapping = await db.attendanceDeviceUser.findFirst({
        where: { deviceId: ev.deviceId, deviceUserId: ev.deviceUserId, enrollmentStatus: "ACTIVE" },
      })
      // 2026-10-07 — automatic mapping: a device User ID that matches an HRM
      // Employee ID (employee code) is mapped on first sight, so the punch is
      // processed instead of parking as UNKNOWN_EMPLOYEE until someone maps it.
      if (!mapping) mapping = await autoMapDeviceUser(ev.vendorId, ev.deviceId, ev.deviceUserId)
      if (!mapping) {
        await db.attendanceRawEvent.update({
          where: { id: ev.id },
          data: { processingStatus: "UNKNOWN_EMPLOYEE", processedAt: new Date(), processingError: "No employee mapping for device user " + ev.deviceUserId },
        })
        await notifyUnknownUser(ev)
        return "UNKNOWN_EMPLOYEE"
      }
      employeeId = mapping.employeeId
      await db.attendanceRawEvent.update({ where: { id: ev.id }, data: { employeeId } })
    }
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ev.vendorId } })
    if (!emp) {
      await db.attendanceRawEvent.update({
        where: { id: ev.id },
        data: { processingStatus: "FAILED", processingError: "Mapped employee no longer exists", processedAt: new Date(), lastAttemptAt: new Date() },
      })
      return "FAILED"
    }
    const date = await attributeDate(ev, ev.vendorId, employeeId, emp.shiftId)
    const res = await rebuildDaily(ev.vendorId, employeeId, date)
    return res.protected && res.touched === false && existingManualCheck(ev, date) ? "SKIPPED_MANUAL" : "PROCESSED"
  } catch (e: any) {
    await db.attendanceRawEvent.update({
      where: { id: ev.id },
      data: { processingStatus: "FAILED", processingError: String(e?.message || e).slice(0, 500), lastAttemptAt: new Date() },
    }).catch(() => {})
    return "FAILED"
  }
}

function existingManualCheck(_ev: RawEvent, _date: string) {
  return true // status already persisted by rebuildDaily
}

/** Notify HR once per unknown PIN (throttled via existing PENDING unknowns) */
async function notifyUnknownUser(ev: RawEvent) {
  try {
    const prior = await db.attendanceRawEvent.count({
      where: { deviceId: ev.deviceId, deviceUserId: ev.deviceUserId, processingStatus: "UNKNOWN_EMPLOYEE", id: { not: ev.id } },
    })
    if (prior === 0) {
      await notify(ev.vendorId, { role: "HR_ADMIN" }, "Unknown Device User",
        `Device ${ev.deviceSerial} reported punch for unknown PIN ${ev.deviceUserId}. Map it to an employee under Attendance → Unknown Device Users.`, "ATTENDANCE", "attendance")
    }
  } catch { /* notification failure must never break ingestion */ }
}

// ---------- bulk reprocessing (spec §24) ----------
export type ReprocessFilters = {
  ids?: string[]
  deviceId?: string
  employeeId?: string
  dateFrom?: string // eventTime >=  (YYYY-MM-DD)
  dateTo?: string // eventTime <=
  status?: string // processingStatus filter (default: non-processed + FAILED)
  includeProcessed?: boolean
}

export async function reprocessEvents(vendorId: string, f: ReprocessFilters) {
  const where: any = { vendorId }
  if (f.ids?.length) where.id = { in: f.ids }
  if (f.deviceId) where.deviceId = f.deviceId
  if (f.employeeId) where.employeeId = f.employeeId
  if (f.dateFrom || f.dateTo) {
    where.eventTime = {}
    if (f.dateFrom) where.eventTime.gte = f.dateFrom + " 00:00:00"
    if (f.dateTo) where.eventTime.lte = f.dateTo + " 23:59:59"
  }
  if (!f.includeProcessed) {
    // 2026-10 historical-sync fix — OUT_OF_WINDOW joins the default reprocess
    // set: quarantined punches can be pulled into attendance on demand.
    where.processingStatus = f.status || { in: ["RECEIVED", "UNKNOWN_EMPLOYEE", "FAILED", "SKIPPED_MANUAL", "OUT_OF_WINDOW"] }
  } else if (f.status) {
    where.processingStatus = f.status
  }
  const events = await db.attendanceRawEvent.findMany({ where, orderBy: { eventTime: "asc" }, take: 2000 })

  // reset then re-run (idempotent — days are rebuilt from the full event set)
  const days = new Set<string>()
  let processed = 0, unknown = 0, failed = 0
  for (const ev of events as unknown as RawEvent[]) {
    await db.attendanceRawEvent.update({ where: { id: ev.id }, data: { employeeId: ev.employeeId, processingStatus: "RECEIVED", processingError: null } })
    const r = await mapAndProcessEvent({ ...ev, processingStatus: "RECEIVED" })
    if (r === "PROCESSED" || r === "SKIPPED_MANUAL") processed++
    else if (r === "UNKNOWN_EMPLOYEE") unknown++
    else failed++
    if (ev.employeeId) days.add(`${ev.employeeId}|${eventDate(ev.eventTime)}`)
  }
  return { matched: events.length, processed, unknown, failed, daysRebuilt: days.size }
}

/** Recalculate attendance for an employee/date-range from raw events (§13). */
export async function recalculateAttendance(vendorId: string, p: { employeeId: string; dateFrom: string; dateTo?: string }) {
  const evs = await db.attendanceRawEvent.findMany({
    where: { vendorId, employeeId: p.employeeId, eventTime: { gte: p.dateFrom + " 00:00:00", lte: (p.dateTo || p.dateFrom) + " 23:59:59" } },
    select: { eventTime: true },
  })
  const days = [...new Set(evs.map((e) => eventDate(e.eventTime)))].sort()
  for (const d of days) await rebuildDaily(vendorId, p.employeeId, d)
  return { days: days.length }
}

// ---------- employee ↔ device mapping (spec §8, §23, §25) ----------
export async function mapDeviceUser(
  ctx: { userId: string; userName: string; vendorId: string; ip?: string },
  p: { deviceId: string; deviceUserId: string; employeeId: string; allowAdditional?: boolean }
) {
  const device = await db.attendanceDevice.findFirst({ where: { id: p.deviceId, vendorId: ctx.vendorId } })
  if (!device) throw Object.assign(new Error("Device not found"), { code: 404 })
  const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: ctx.vendorId } })
  if (!emp) throw Object.assign(new Error("Employee not found"), { code: 404 })
  const dup = await db.attendanceDeviceUser.findFirst({
    where: { deviceId: p.deviceId, employeeId: p.employeeId, deviceUserId: { not: p.deviceUserId }, enrollmentStatus: "ACTIVE" },
  })
  // 2026-10-07 — a PIN equal to the employee's own Employee ID is always
  // allowed as an additional enrolment (re-enrolled under the Employee ID);
  // only an unrelated second PIN is refused, or allowed with explicit
  // `allowAdditional` from the admin.
  const isOwnId = normId(p.deviceUserId) === normId(emp.code)
  if (dup && !isOwnId && !p.allowAdditional) {
    throw Object.assign(new Error(`${emp.fullName} is already mapped to PIN ${dup.deviceUserId} on this device — tick "also keep existing PIN" to add PIN ${p.deviceUserId} as a second enrolment`), { code: 400 })
  }

  const existing = await db.attendanceDeviceUser.findFirst({ where: { deviceId: p.deviceId, deviceUserId: p.deviceUserId } })
  let mapping
  if (existing) {
    mapping = await db.attendanceDeviceUser.update({
      where: { id: existing.id },
      data: { employeeId: p.employeeId, enrollmentStatus: "ACTIVE", lastSyncedAt: new Date() },
    })
  } else {
    mapping = await db.attendanceDeviceUser.create({
      data: { vendorId: ctx.vendorId, deviceId: p.deviceId, employeeId: p.employeeId, deviceUserId: p.deviceUserId, lastSyncedAt: new Date() },
    })
  }
  await audit(ctx as any, "devices.mapUser", "AttendanceDeviceUser", mapping.id,
    `Mapped device ${device.name} PIN ${p.deviceUserId} → ${emp.fullName} (${emp.code})`,
    { oldValue: existing ? { employeeId: existing.employeeId, status: existing.enrollmentStatus } : null, newValue: { employeeId: p.employeeId } })

  // MED-19 (this audit) — when re-mapping a PIN to a DIFFERENT employee, null
  // out the historical employeeId on already-mapped raw events so reprocessEvents
  // re-resolves the mapping via mapAndProcessEvent (which short-circuits when
  // employeeId is already set). The previous code skipped already-mapped events,
  // leaving attendance bound to the OLD employee.
  if (existing && existing.employeeId !== p.employeeId) {
    await db.attendanceRawEvent.updateMany({
      where: { deviceId: p.deviceId, deviceUserId: p.deviceUserId, employeeId: { not: null } },
      data: { employeeId: null, processingStatus: "RECEIVED", processingError: null },
    })
  }

  // reprocess ALL historical events for this PIN with the new mapping (§23)
  // After MED-19 fix above, previously-mapped events now have employeeId=null
  // AND processingStatus=RECEIVED → they re-resolve through the new mapping.
  const res = await reprocessEvents(ctx.vendorId, { deviceId: p.deviceId, includeProcessed: true, status: "UNKNOWN_EMPLOYEE" })
  const pinRes = await reprocessEvents(ctx.vendorId, { deviceId: p.deviceId, includeProcessed: false })
  return { mapping, reprocessed: res.matched + pinRes.matched, daysRebuilt: Math.max(res.daysRebuilt, pinRes.daysRebuilt) }
}

export async function unmapDeviceUser(
  ctx: { userId: string; userName: string; vendorId: string },
  p: { deviceId: string; deviceUserId: string }
) {
  const existing = await db.attendanceDeviceUser.findFirst({ where: { deviceId: p.deviceId, deviceUserId: p.deviceUserId } })
  if (!existing) throw Object.assign(new Error("Mapping not found"), { code: 404 })
  await db.attendanceDeviceUser.update({ where: { id: existing.id }, data: { enrollmentStatus: "INACTIVE" } })
  await audit(ctx as any, "devices.unmap", "AttendanceDeviceUser", existing.id, `Deactivated mapping PIN ${p.deviceUserId} on device ${p.deviceId}`)
  return { ok: true }
}

/** Offboarding (spec §25): mark the employee's device enrollments inactive —
 *  historical attendance is never deleted. */
export async function deactivateMappingsForEmployee(vendorId: string, employeeId: string) {
  await db.attendanceDeviceUser.updateMany({ where: { vendorId, employeeId, enrollmentStatus: "ACTIVE" }, data: { enrollmentStatus: "INACTIVE" } })
}

// ---------- automatic employee ↔ device mapping (2026-10-07) ----------
/** Normalise an ID for comparison: trim, upper-case. */
const normId = (v: string) => String(v || "").trim().toUpperCase()

/** MOD-20 (Phase 2 WS2) — short-TTL per-vendor employee directory cache for
 *  the NUMERIC auto-map rule. The numeric tail comparison needs the tenant's
 *  codes in memory, but loading them PER unknown punch / PER roster user
 *  (35K queries per ESS date pick at 5K staff) was the bug; a 60 s cache
 *  collapses that to one load per vendor per minute. Bounded: stale entries
 *  evicted first, hard cap, and an explicit invalidation hook for tests. */
const DIRECTORY_TTL_MS = 60_000
const DIRECTORY_MAX_VENDORS = 500
const employeeDirectoryCache = new Map<string, { at: number; rows: { id: string; code: string; fullName: string }[] }>()
export function invalidateEmployeeDirectoryCache(vendorId?: string): void {
  if (vendorId) employeeDirectoryCache.delete(vendorId)
  else employeeDirectoryCache.clear()
}
async function cachedEmployeeDirectory(vendorId: string): Promise<{ id: string; code: string; fullName: string }[]> {
  const hit = employeeDirectoryCache.get(vendorId)
  if (hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.rows
  const rows = await db.employee.findMany({ where: { vendorId }, select: { id: true, code: true, fullName: true } })
  if (employeeDirectoryCache.size >= DIRECTORY_MAX_VENDORS) {
    // evict stale entries first, then the oldest-inserted (Map preserves
    // insertion order) — bounded memory at any tenant count
    const now = Date.now()
    for (const [k, v] of employeeDirectoryCache) {
      if (now - v.at >= DIRECTORY_TTL_MS) employeeDirectoryCache.delete(k)
    }
    while (employeeDirectoryCache.size >= DIRECTORY_MAX_VENDORS) {
      const first = employeeDirectoryCache.keys().next().value
      if (first == null) break
      employeeDirectoryCache.delete(first)
    }
  }
  employeeDirectoryCache.set(vendorId, { at: Date.now(), rows })
  return rows
}

/** Find the HRM employee whose Employee ID (code) matches a device User ID.
 *  Rules, strongest first — a match is used only when it is UNAMBIGUOUS:
 *   1. exact Employee ID, case-insensitive ("TCSBL-005" ↔ "tcsbl-005");
 *   2. numeric device PIN ↔ the numeric part of the Employee ID, compared as
 *      numbers ("12" / "0012" ↔ "EMP-0012") — the same PIN the HRM assigns
 *      when it pushes employees to a device. Ambiguous (two employees share
 *      the number, e.g. EMP-0012 and CON-12) → no match (manual mapping).
 *  MOD-20 — rule 1 is now an INDEXED lookup on unique(vendorId, code)
 *  (vendor-bounded, take 2 for the ambiguity check) instead of loading the
 *  whole tenant; rule 2 still needs the directory and reads it through the
 *  60 s cache above. Both rules' semantics are byte-identical. */
export async function findEmployeeForDeviceUser(
  vendorId: string, deviceUserId: string,
  directory?: { id: string; code: string; fullName: string }[],
): Promise<{ id: string; code: string; fullName: string; rule: "EXACT" | "NUMERIC" } | null> {
  const pin = normId(deviceUserId)
  if (!pin) return null
  // rule 1 — indexed case-insensitive exact match (take 2 detects ambiguity)
  const exact = directory
    ? directory.filter((e) => normId(e.code) === pin)
    : await db.employee.findMany({
        where: { vendorId, code: { equals: deviceUserId.trim(), mode: "insensitive" } },
        select: { id: true, code: true, fullName: true },
        take: 2,
      }).then((rows) => rows.filter((e) => normId(e.code) === pin))
  if (exact.length === 1) return { ...exact[0], rule: "EXACT" }
  if (exact.length > 1) return null
  // rule 2 — numeric tail via the (cached) directory
  if (/^\d+$/.test(pin)) {
    const emps = directory || await cachedEmployeeDirectory(vendorId)
    const n = Number(pin)
    const numeric = emps.filter((e) => {
      const tail = (e.code.match(/(\d+)\s*$/) || [])[1]
      return tail != null && Number(tail) === n
    })
    if (numeric.length === 1) return { ...numeric[0], rule: "NUMERIC" }
  }
  return null
}

/** Create the ACTIVE mapping for a device PIN when its Employee ID matches an
 *  HRM employee. Never overrides an admin decision: an existing mapping row
 *  for the PIN (ACTIVE or deliberately INACTIVE) is left alone, and an
 *  employee already mapped to a different PIN on the same device is skipped.
 *  Returns the ACTIVE mapping (existing or new) or null. */
export async function autoMapDeviceUser(
  vendorId: string, deviceId: string, deviceUserId: string,
  opts?: { skipRequeue?: boolean; directory?: { id: string; code: string; fullName: string }[] },
) {
  const existing = await db.attendanceDeviceUser.findFirst({ where: { deviceId, deviceUserId } })
  if (existing) return existing.enrollmentStatus === "ACTIVE" ? existing : null
  const emp = await findEmployeeForDeviceUser(vendorId, deviceUserId, opts?.directory)
  if (!emp) return null
  // An employee re-enrolled on the terminal under their Employee ID (e.g. an
  // old numeric PIN "6" plus the new "TCSBL-006") keeps BOTH PINs: an EXACT
  // Employee-ID match is unambiguous, so it is mapped as an additional PIN.
  // A numeric-only match is weaker and never adds a second PIN.
  if (emp.rule !== "EXACT") {
    const taken = await db.attendanceDeviceUser.findFirst({
      where: { deviceId, employeeId: emp.id, enrollmentStatus: "ACTIVE" },
    })
    if (taken) return null
  }
  let mapping
  try {
    mapping = await db.attendanceDeviceUser.create({
      data: { vendorId, deviceId, employeeId: emp.id, deviceUserId, lastSyncedAt: new Date() },
    })
  } catch {
    // unique(deviceId, deviceUserId) race — a concurrent request mapped it
    return db.attendanceDeviceUser.findFirst({ where: { deviceId, deviceUserId, enrollmentStatus: "ACTIVE" } })
  }
  await audit({ userId: null, userName: "Device auto-mapping", vendorId }, "devices.autoMap", "AttendanceDeviceUser", mapping.id,
    `Auto-mapped device PIN ${deviceUserId} → ${emp.fullName} (${emp.code}) — Employee ID match (${emp.rule === "EXACT" ? "exact" : "numeric"})`,
    { newValue: { deviceId, deviceUserId, employeeId: emp.id, rule: emp.rule } })
  if (!opts?.skipRequeue) {
    // punches of this PIN already parked as UNKNOWN go back to the queue —
    // the sweeper processes them through the new mapping within ~15 s
    await db.attendanceRawEvent.updateMany({
      where: { vendorId, deviceId, deviceUserId, processingStatus: "UNKNOWN_EMPLOYEE" },
      data: { processingStatus: "RECEIVED", processingError: null },
    })
  }
  return mapping
}

/** Bulk auto-map: every unmapped PIN seen on the tenant's devices (punches
 *  parked as UNKNOWN + the device roster) whose Employee ID matches. */
export async function autoMapAll(vendorId: string, deviceIds?: string[]) {
  const directory = await db.employee.findMany({ where: { vendorId }, select: { id: true, code: true, fullName: true } })
  const devices = await db.attendanceDevice.findMany({
    where: { vendorId, ...(deviceIds?.length ? { id: { in: deviceIds } } : {}) },
    select: { id: true, configuration: true },
  })
  const pins = new Map<string, Set<string>>() // deviceId → PINs
  for (const d of devices) {
    const set = new Set<string>()
    try { for (const pin of Object.keys(JSON.parse(d.configuration || "{}")?.roster || {})) set.add(pin) } catch { /* bad JSON */ }
    pins.set(d.id, set)
  }
  const unknown = await db.attendanceRawEvent.groupBy({
    by: ["deviceId", "deviceUserId"],
    where: { vendorId, processingStatus: "UNKNOWN_EMPLOYEE", deviceId: { in: devices.map((d) => d.id) } },
  })
  for (const u of unknown) pins.get(u.deviceId)?.add(u.deviceUserId)
  let mapped = 0, considered = 0
  const results: { deviceId: string; deviceUserId: string; employeeCode?: string; status: "MAPPED" | "NO_MATCH" | "ALREADY" }[] = []
  for (const [deviceId, set] of pins) {
    for (const pin of set) {
      considered++
      const before = await db.attendanceDeviceUser.findFirst({ where: { deviceId, deviceUserId: pin } })
      if (before) { results.push({ deviceId, deviceUserId: pin, status: "ALREADY" }); continue }
      const m = await autoMapDeviceUser(vendorId, deviceId, pin, { directory })
      if (m) {
        mapped++
        results.push({ deviceId, deviceUserId: pin, employeeCode: directory.find((e) => e.id === m.employeeId)?.code, status: "MAPPED" })
      } else results.push({ deviceId, deviceUserId: pin, status: "NO_MATCH" })
    }
  }
  return { considered, mapped, results }
}

// ---------- unknown users summary (spec §11, §23) ----------
export async function unknownUsers(vendorId: string) {
  const evs = await db.attendanceRawEvent.findMany({
    where: { vendorId, processingStatus: "UNKNOWN_EMPLOYEE" },
    orderBy: { eventTime: "asc" },
    select: { deviceId: true, deviceSerial: true, deviceUserId: true, eventTime: true },
  })
  const devices = await db.attendanceDevice.findMany({ where: { vendorId }, select: { id: true, name: true, branchId: true, deviceIdentifier: true, configuration: true } })
  type Row = {
    deviceId: string; deviceSerial: string; deviceUserId: string; deviceName: string
    events: number; firstSeen: string | null; lastSeen: string | null
    deviceUserName?: string | null
    suggestedEmployeeId?: string | null; suggestedEmployee?: string | null; suggestedRule?: string | null
  }
  const groups: Record<string, Row> = {}
  for (const ev of evs) {
    const key = `${ev.deviceId}|${ev.deviceUserId}`
    if (!groups[key]) {
      groups[key] = {
        deviceId: ev.deviceId, deviceSerial: ev.deviceSerial, deviceUserId: ev.deviceUserId,
        deviceName: devices.find((d) => d.id === ev.deviceId)?.name || ev.deviceSerial,
        events: 0, firstSeen: ev.eventTime, lastSeen: ev.eventTime,
      }
    }
    groups[key].events++
    if (ev.eventTime > (groups[key].lastSeen || "")) groups[key].lastSeen = ev.eventTime
  }
  // 2026-10-07 — device-roster users (learned from the device's USER push)
  // with no mapping are listed too, so they can be mapped BEFORE they punch.
  const mappedRows = await db.attendanceDeviceUser.findMany({ where: { vendorId }, select: { deviceId: true, deviceUserId: true } })
  const mappedKeys = new Set(mappedRows.map((m) => `${m.deviceId}|${m.deviceUserId}`))
  for (const d of devices) {
    let roster: Record<string, { name?: string | null }> = {}
    try { roster = JSON.parse(d.configuration || "{}")?.roster || {} } catch { roster = {} }
    for (const [pin, info] of Object.entries(roster)) {
      const key = `${d.id}|${pin}`
      if (groups[key]) { groups[key].deviceUserName = info?.name || null; continue }
      if (mappedKeys.has(key)) continue
      groups[key] = {
        deviceId: d.id, deviceSerial: d.deviceIdentifier || "", deviceUserId: pin, deviceName: d.name,
        events: 0, firstSeen: null, lastSeen: null, deviceUserName: info?.name || null,
      }
    }
  }
  // suggestion = the Employee-ID match the automatic mapper would use (shown
  // to the admin; ambiguous / no match → null → choose manually)
  const directory = await db.employee.findMany({ where: { vendorId }, select: { id: true, code: true, fullName: true } })
  for (const g of Object.values(groups)) {
    const m = await findEmployeeForDeviceUser(vendorId, g.deviceUserId, directory)
    g.suggestedEmployeeId = m?.id || null
    g.suggestedEmployee = m ? `${m.fullName} — ${m.code}` : null
    g.suggestedRule = m?.rule || null
  }
  return Object.values(groups).sort((a, b) => b.events - a.events || a.deviceUserId.localeCompare(b.deviceUserId))
}

// ---------- sync stats (spec §33) ----------
export async function syncStats(vendorId: string) {
  const vendorSettings = await getSettings(vendorId)
  const todayStr = new Date().toISOString().slice(0, 10)
  const byStatus = await db.attendanceRawEvent.groupBy({ by: ["processingStatus"], where: { vendorId }, _count: true })
  const counts: Record<string, number> = {}
  for (const r of byStatus) counts[r.processingStatus] = r._count as number
  const lastEvent = await db.attendanceRawEvent.findFirst({ where: { vendorId }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true, eventTime: true } })
  const todayCount = await db.attendanceRawEvent.count({ where: { vendorId, eventTime: { gte: todayStr + " 00:00:00", lte: todayStr + " 23:59:59" } } })
  const devices = await db.attendanceDevice.findMany({ where: { vendorId } })
  const _unknown = await db.attendanceRawEvent.count({ where: { vendorId, processingStatus: "UNKNOWN_EMPLOYEE" } })
  const autoSyncQueued = await db.deviceCommand.count({
    where: { vendorId, status: "QUEUED", command: { startsWith: "CHECK" }, createdBy: "auto-sync" },
  })
  const lastAutoCheck = await db.deviceCommand.findFirst({
    where: { vendorId, command: { startsWith: "CHECK" }, createdBy: "auto-sync" },
    orderBy: { createdAt: "desc" }, select: { createdAt: true },
  })
  return {
    queue: {
      received: counts.RECEIVED || 0,
      processed: counts.PROCESSED || 0,
      unknown: counts.UNKNOWN_EMPLOYEE || 0,
      failed: counts.FAILED || 0,
      skippedManual: counts.SKIPPED_MANUAL || 0,
      total: Object.values(counts).reduce((s, n) => s + n, 0),
    },
    devices: { total: devices.length, enabled: devices.filter((d) => d.enabled).length },
    // C-03 — Sync Monitor: keyless devices are governed by the vendor admin
    // setting "Allow Keyless Devices" (Settings → Devices). While it is OFF
    // their pushes are rejected with 401 until a key is enrolled or the
    // setting is enabled (the old 7-day grace window was removed).
    commKey: {
      enrolled: devices.filter((d) => d.enabled && (d.commKeyHash || d.commKey)).length,
      keyless: devices.filter((d) => d.enabled && !(d.commKeyHash || d.commKey)).length,
      allowKeyless: vendorSettings.devices?.allowKeyless ?? false,
    },
    // Automatic attendance pull (auto-CHECK loop) — surfaced in the Sync Monitor
    autoSync: {
      enabled: GATEWAY_ENV.autoCheckSec() > 0,
      intervalSec: GATEWAY_ENV.autoCheckSec(),
      queued: autoSyncQueued,
      lastAt: lastAutoCheck?.createdAt || null,
    },
    unknownUsers: (await unknownUsers(vendorId)).length,
    todayEvents: todayCount,
    lastEventReceivedAt: lastEvent?.receivedAt || null,
    lastEventTime: lastEvent?.eventTime || null,
  }
}

export { titleCase }

// ============ Attendance Device admin routes (spec §6, §20–§24, §40) ============
// Session-authenticated HRM admin API for the ZKTeco ADMS integration.
// Permissions (existing module.action convention):
//   devices.view / create / edit / delete / process / export
// Branch managers are scoped to their own branch's devices & events.
import crypto from "crypto"
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, employeeScopeFilter } from "../rbac"
import { audit } from "../audit"
import { cleanForm } from "../utils"
import { requireCapacity } from "../saas/entitlements"
import { derivedStatus, sweepOnce } from "../zkteco/gateway"
import { verifyModeLabel, fmtDrift, isAllowedCommand } from "../zkteco/adapter"
import { hashCommKeyAsync } from "../zkteco/commkey"
import { encryptCommKey, commKeyEncryptionAvailable } from "../zkteco/comm-key"
import {
  reprocessEvents, recalculateAttendance, mapDeviceUser, unmapDeviceUser,
  unknownUsers, syncStats, rebuildDaily, autoMapAll,
} from "../zkteco/processor"

const SN_RE = /^[A-Za-z0-9_-]{4,64}$/

/** Device scope: branch managers administer only their branch's devices. */
function deviceScopeFilter(ctx: any): Record<string, unknown> {
  const f: Record<string, unknown> = { vendorId: ctx.vendorId }
  if (ctx.role === "BRANCH_MANAGER" && ctx.branchId) f.branchId = ctx.branchId
  return f
}

function deviceScopeNarrow(ctx: any): boolean {
  return ctx.role === "BRANCH_MANAGER" && !!ctx.branchId
}

/** M-14 (re-ported R3-2) — the caller's scoped device ids, or null when the
 *  caller is unscoped (HR admin / owner — the whole tenant's devices,
 *  including logs whose deviceId is null, stay visible exactly as before). */
async function scopedDeviceIds(ctx: any): Promise<string[] | null> {
  if (!deviceScopeNarrow(ctx)) return null
  const devices = await db.attendanceDevice.findMany({ where: deviceScopeFilter(ctx), select: { id: true } })
  return devices.map((d) => d.id)
}

function publicDevice(d: any) {
  // never expose raw configuration secrets — C-03: the plaintext commKey is
  // write-only (shown once at enrollment via devices.setCommKey) and must
  // never leak through any list/get response.
  const { commKey, commKeyHash, commKeySalt: _commKeySalt, configuration: _configuration, ...rest } = d
  return {
    ...rest,
    hasCommKey: !!(commKeyHash || commKey), // enrollment state for the UI badge
    derivedStatus: derivedStatus(d),
  }
}

// ---------- device list (spec §6) ----------
route("devices.list", {
  perm: ["devices", "view"],
  handler: async (ctx) => {
    const devices = await db.attendanceDevice.findMany({ where: deviceScopeFilter(ctx), orderBy: { createdAt: "asc" } })
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const todayStr = new Date().toISOString().slice(0, 10)
    const todayByDevice = await db.attendanceRawEvent.groupBy({
      by: ["deviceId"], where: { vendorId: ctx.vendorId, eventTime: { gte: todayStr + " 00:00:00", lte: todayStr + " 23:59:59" } },
      _count: true,
    })
    const lastByDevice = await db.attendanceRawEvent.groupBy({
      by: ["deviceId"], where: { vendorId: ctx.vendorId }, _max: { eventTime: true },
    })
    const mappingCounts = await db.attendanceDeviceUser.groupBy({
      by: ["deviceId"], where: { vendorId: ctx.vendorId, enrollmentStatus: "ACTIVE" }, _count: true,
    })
    const unknownCounts = await db.attendanceRawEvent.groupBy({
      by: ["deviceId"], where: { vendorId: ctx.vendorId, processingStatus: "UNKNOWN_EMPLOYEE" }, _count: true,
    })
    // C-4 — Sync Monitor: rejected-out-of-window event count per device
    const outOfWindowCounts = await db.deviceCommLog.groupBy({
      by: ["deviceId"], where: { vendorId: ctx.vendorId, ok: false, error: { startsWith: "OUT_OF_WINDOW" } }, _count: true,
    })
    return devices.map((d) => publicDevice({
      ...d,
      branchName: branches.find((b) => b.id === d.branchId)?.name,
      todayEvents: (todayByDevice.find((t) => t.deviceId === d.id)?._count as number) || 0,
      lastEventTime: lastByDevice.find((t) => t.deviceId === d.id)?._max.eventTime || null,
      activeMappings: (mappingCounts.find((t) => t.deviceId === d.id)?._count as number) || 0,
      unknownUsers: (unknownCounts.find((t) => t.deviceId === d.id)?._count as number) || 0,
      outOfWindowEvents: (outOfWindowCounts.find((t) => t.deviceId === d.id)?._count as number) || 0,
      clockDrift: fmtDrift(d.clockDriftSec),
    }))
  },
})

// ---------- device detail (spec §6, §21) ----------
route("devices.get", {
  perm: ["devices", "view"],
  handler: async (ctx, p) => {
    const d = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const todayStr = new Date().toISOString().slice(0, 10)
    const todayEvents = await db.attendanceRawEvent.count({
      where: { deviceId: d.id, eventTime: { gte: todayStr + " 00:00:00", lte: todayStr + " 23:59:59" } },
    })
    const lastEvent = await db.attendanceRawEvent.findFirst({ where: { deviceId: d.id }, orderBy: { eventTime: "desc" }, select: { eventTime: true } })
    const unknownUsersCount = await db.attendanceRawEvent.count({ where: { deviceId: d.id, processingStatus: "UNKNOWN_EMPLOYEE" } })
    const mappings = await db.attendanceDeviceUser.findMany({
      where: { deviceId: d.id }, orderBy: { deviceUserId: "asc" },
    })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true, status: true } })
    const recentEvents = await db.attendanceRawEvent.findMany({
      where: { deviceId: d.id }, orderBy: { eventTime: "desc" }, take: 25,
    })
    const commLogs = await db.deviceCommLog.findMany({
      where: { deviceId: d.id }, orderBy: { createdAt: "desc" }, take: 20,
    })
    // C-4 — Sync Monitor: rejected-out-of-window counter for the detail view
    const outOfWindowCount = await db.deviceCommLog.count({
      where: { deviceId: d.id, ok: false, error: { startsWith: "OUT_OF_WINDOW" } },
    })
    const commands = await db.deviceCommand.findMany({
      where: { deviceId: d.id }, orderBy: { createdAt: "desc" }, take: 10,
    })
    const eventStats = await db.attendanceRawEvent.groupBy({
      by: ["processingStatus"], where: { deviceId: d.id }, _count: true,
    })
    const statusCounts: Record<string, number> = {}
    for (const r of eventStats) statusCounts[r.processingStatus] = r._count as number
    return {
      device: publicDevice({
        ...d,
        branchName: branches.find((b) => b.id === d.branchId)?.name,
        clockDrift: fmtDrift(d.clockDriftSec),
        todayEvents,
        lastEventTime: lastEvent?.eventTime || null,
        unknownUsers: unknownUsersCount,
        outOfWindowEvents: outOfWindowCount,
      }),
      mappings: mappings.map((m) => ({
        ...m,
        employeeName: employees.find((e) => e.id === m.employeeId)?.fullName || "—",
        employeeCode: employees.find((e) => e.id === m.employeeId)?.code,
        employeeStatus: employees.find((e) => e.id === m.employeeId)?.status,
      })),
      recentEvents: recentEvents.map((e) => ({
        ...e,
        employeeName: e.employeeId ? employees.find((x) => x.id === e.employeeId)?.fullName || "— (unmapped)" : null,
        verifyLabel: verifyModeLabel(e.verifyMode),
      })),
      commLogs,
      commands,
      eventStats: statusCounts,
    }
  },
})

// ---------- create / update (spec §38, §47) ----------
route("devices.save", {
  perm: ["devices", "create"],
  handler: async (ctx, p) => {
    const v = cleanForm(p)
    if (!v.name) throw new Deny("Device name is required", 400)
    const sn = String(v.deviceIdentifier || v.serialNumber || "").trim()
    if (!sn || !SN_RE.test(sn)) throw new Deny("A valid ADMS serial number (SN) is required — the device pushes with SN=" + (sn || "?"), 400)
    if (v.branchId) {
      const br = await db.branch.findFirst({ where: { id: v.branchId, vendorId: ctx.vendorId } })
      if (!br) throw new Deny("Branch not found", 404)
    }
    const dup = await db.attendanceDevice.findFirst({ where: { deviceIdentifier: sn, ...(p.id ? { id: { not: p.id } } : {}) } })
    // C-03 — tenant-neutral: never reveal the other tenant's device name.
    if (dup) throw new Deny(`SN ${sn} is already registered to another deployment — serials are globally unique`, 400)

    const data: any = {
      name: v.name,
      deviceIdentifier: sn,
      serialNumber: v.serialNumber || sn,
      branchId: v.branchId || null,
      manufacturer: v.manufacturer || (v.protocol === "HIKVISION_ISAPI" ? "Hikvision" : "ZKTeco"),
      model: v.model || (v.protocol === "HIKVISION_ISAPI" ? "DS-K1T804" : "SenseFace 3A"),
      location: v.location || null,
      protocol: v.protocol === "HIKVISION_ISAPI" ? "HIKVISION_ISAPI" : "ADMS",
      timezone: v.timezone || "Asia/Dhaka",
      ipAddress: v.ipAddress || null,
      port: v.port ? Number(v.port) : null,
    }

    if (p.id) {
      // edit — requires devices.edit, enforced here so one dialog can serve both
      const { require } = await import("../rbac")
      require(ctx, "devices", "edit")
      const existing = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
      if (!existing) throw new Deny("Device not found in your scope", 404)
      const rec = await db.attendanceDevice.update({ where: { id: p.id }, data })
      await audit(ctx, "devices.update", "AttendanceDevice", rec.id, `Updated device ${rec.name} (${sn})`, { oldValue: { name: existing.name, branchId: existing.branchId }, newValue: { name: data.name, branchId: data.branchId } })
      return publicDevice(rec)
    }
    // SaaS plan capacity — device seats (LEGACY tenants pass)
    await requireCapacity(ctx.vendorId, "DEVICES", 1)
    const rec = await db.attendanceDevice.create({
      data: { ...data, vendorId: ctx.vendorId, deviceId: v.deviceId || sn, status: "OFFLINE", enabled: true },
    })
    await audit(ctx, "devices.create", "AttendanceDevice", rec.id, `Registered ADMS device ${rec.name} (SN ${sn}) — waiting for first connection`)
    return publicDevice(rec)
  },
})

// ---------- enable / disable (soft state — spec §7) ----------
route("devices.setEnabled", {
  perm: ["devices", "edit"],
  handler: async (ctx, p) => {
    const d = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    const enabled = !!p.enabled
    // SUB-005 (re-ported R3-2) — re-enabling a disabled device consumes a
    // device seat again (usageSnapshot counts enabled devices), so the DEVICES
    // capacity check the create path applies must also run when a device
    // flips back on; otherwise turning devices off/on bypassed the seat cap.
    if (enabled && !d.enabled) {
      await requireCapacity(ctx.vendorId, "DEVICES", 1)
    }
    // When enabling: clear the "disabled" lastError and set status to OFFLINE
    // (the device will flip to ONLINE on its next push — typically within
    // LOGDELAY seconds). When disabling: mark status OFFLINE with a clear reason.
    const rec = await db.attendanceDevice.update({
      where: { id: d.id },
      data: {
        enabled,
        status: "OFFLINE",
        lastError: enabled ? null : "Disabled by " + ctx.userName,
      },
    })
    await audit(ctx, enabled ? "devices.enable" : "devices.disable", "AttendanceDevice", d.id, `${enabled ? "Enabled" : "Disabled"} device ${d.name} (SN ${d.deviceIdentifier})`)
    return publicDevice(rec)
  },
})

// ---------- C-03: comm-key authentication reintroduced ----------
// Credential routes live here again (see devices.setCommKey below): the
// audit finding C-03 requires a shared secret alongside the pre-registered
// serial, verified timing-safely in zkteco/gateway.resolveDevice.

// ---------- C-03: comm-key enrollment ----------
// Sets (or rotates) a device's comm key. When `key` is omitted a random
// 12-hex-char key is generated server-side. The plaintext is stored once (for
// re-display convenience it is also retrievable ONLY via setCommKey regenerate
// — responses never include it) and the scrypt hash is what the gateway
// verifies. Returns the plaintext exactly ONCE so the operator can key it into
// the device firmware (ZKTeco: Communication Key menu).
route("devices.setCommKey", {
  perm: ["devices", "edit"],
  handler: async (ctx, p) => {
    const d = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    // accept operator-supplied key (4..64 printable chars) or generate one
    const key = p.key ? String(p.key).trim() : crypto.randomBytes(6).toString("hex").toUpperCase()
    if (!/^[!-~]{4,64}$/.test(key)) throw new Deny("Comm key must be 4–64 printable ASCII characters", 400)
    // M-20 — the comm key is stored ENCRYPTED at rest (AES-256-GCM under
    // HRM_MFA_KEY, context devices::v1). Previously the plaintext column sat
    // alongside the scrypt hash, handing working device credentials to anyone
    // with a database dump. Fails closed like MFA enrollment / camera creds.
    if (!commKeyEncryptionAvailable()) {
      throw new Deny("Comm keys cannot be enrolled because the server encryption key (HRM_MFA_KEY) is not configured — ask an administrator to set it", 500)
    }
    // SCL-2 (Phase 1) — async scrypt on the request path (devices.setCommKey)
    const { hash, salt } = await hashCommKeyAsync(key)
    await db.attendanceDevice.update({
      where: { id: d.id },
      data: { commKey: encryptCommKey(key), commKeyHash: hash, commKeySalt: salt, commKeySetAt: new Date() },
    })
    await audit(ctx, "devices.setCommKey", "AttendanceDevice", d.id,
      `Enrolled/rotated comm key for device ${d.name} (SN ${d.deviceIdentifier}) — plaintext shown once`)
    // shown exactly once — the caller must key it into the device firmware now
    return { ok: true, id: d.id, sn: d.deviceIdentifier, key, note: "Store this key now — it will not be shown again. Enter it on the device: Menu → Communication → Comm Key." }
  },
})

// ---------- hard delete — only when no history exists (spec §7) ----------
route("devices.delete", {
  perm: ["devices", "delete"],
  handler: async (ctx, p) => {
    const d = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    const evCount = await db.attendanceRawEvent.count({ where: { deviceId: d.id } })
    const mapCount = await db.attendanceDeviceUser.count({ where: { deviceId: d.id } })
    if (evCount > 0 || mapCount > 0) {
      throw new Deny(`Device has ${evCount} attendance event(s) and ${mapCount} employee mapping(s). Use "Permanently Delete" (devices.hardDelete) to remove the device AND all its history, or disable the device instead.`, 400)
    }
    await db.deviceCommLog.deleteMany({ where: { deviceId: d.id } })
    await db.deviceCommand.deleteMany({ where: { deviceId: d.id } })
    await db.attendanceDevice.delete({ where: { id: d.id } })
    await audit(ctx, "devices.delete", "AttendanceDevice", d.id, `Deleted unused device ${d.name} (SN ${d.deviceIdentifier})`)
    return { ok: true }
  },
})

// ---------- hard delete (irreversible) — for dummy/test devices ----------
// Removes the device AND all its history: raw events, employee mappings,
// comm logs, queued commands. Use ONLY for dummy/test data — for production
// devices use the soft-disable (devices.setEnabled) so attendance history
// stays auditable. Requires `confirm: "DELETE"` to prevent accidents.
route("devices.hardDelete", {
  perm: ["devices", "delete"],
  handler: async (ctx, p) => {
    if (p.confirm !== "DELETE") {
      throw new Deny("Confirmation required — pass confirm='DELETE' to proceed.", 400)
    }
    const d = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    const stats = {
      events: await db.attendanceRawEvent.count({ where: { deviceId: d.id } }),
      mappings: await db.attendanceDeviceUser.count({ where: { deviceId: d.id } }),
      commLogs: await db.deviceCommLog.count({ where: { deviceId: d.id } }),
      commands: await db.deviceCommand.count({ where: { deviceId: d.id } }),
    }
    // H-14 — single atomic transaction, explicit dependency order, no swallows:
    // any failing delete aborts everything (device row stays + audit shows why).
    await db.$transaction(async (tx) => {
      // 1. leaf history rows
      await tx.attendanceRawEvent.deleteMany({ where: { deviceId: d.id } })
      await tx.attendanceDeviceUser.deleteMany({ where: { deviceId: d.id } })
      await tx.deviceCommLog.deleteMany({ where: { deviceId: d.id } })
      await tx.deviceCommand.deleteMany({ where: { deviceId: d.id } })
      // 2. the device row itself
      await tx.attendanceDevice.delete({ where: { id: d.id } })
    })
    await audit(ctx, "devices.hardDelete", "AttendanceDevice", d.id,
      `Hard-deleted device ${d.name} (SN ${d.deviceIdentifier}) — removed ${stats.events} events, ${stats.mappings} mappings, ${stats.commLogs} comm logs, ${stats.commands} commands`,
      { oldValue: { ...d, ...stats } })
    return { deleted: true, name: d.name, sn: d.deviceIdentifier, ...stats }
  },
})

// ---------- push/sync employees to device (server → device roster) ----------
// Registers in-scope employees as device users (stable PIN per employee, no
// duplicates) and queues a DATA UPDATE USERINFO command — the device fetches
// the roster on its next getrequest poll. Already-registered employees are
// reported, never re-registered. Requires devices.edit (roster mutation).
route("devices.pushEmployees", {
  perm: ["devices", "edit"],
  handler: async (ctx, p) => {
    const d = await db.attendanceDevice.findFirst({ where: { id: p.deviceId, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    if (!d.enabled) throw new Deny("Device is disabled — enable it before pushing employees", 400)

    // employees in the caller's tenant + branch/department visibility scope,
    // working statuses only (exited staff are never pushed)
    const employees = await db.employee.findMany({
      where: {
        ...employeeScopeFilter(ctx),
        status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "NOTICE_PERIOD"] },
      },
      select: { id: true, code: true, fullName: true, status: true },
      orderBy: { code: "asc" },
    })
    // branch devices serve that branch's employees first; others still push
    // (multi-branch door devices) — no filtering beyond scope above.

    const existing = await db.attendanceDeviceUser.findMany({
      where: { deviceId: d.id, enrollmentStatus: "ACTIVE" },
      select: { employeeId: true, deviceUserId: true },
    })
    const registered = new Map(existing.map((m) => [m.employeeId, m.deviceUserId]))
    const usedPins = new Set(existing.map((m) => m.deviceUserId))

    // stable PIN: numeric tail of the employee code (EMP-0012 → 12); fall back
    // to the first free number when taken (never collides on this device)
    const pinFor = (code: string): string => {
      const tail = (code.match(/(\d+)\s*$/) || [])[1]
      if (tail) {
        const pin = String(Number(tail))
        if (!usedPins.has(pin)) { usedPins.add(pin); return pin }
        const padded = tail.padStart(4, "0")
        if (!usedPins.has(padded)) { usedPins.add(padded); return padded }
      }
      let n = 1
      while (usedPins.has(String(n))) n++
      usedPins.add(String(n))
      return String(n)
    }

    const results: { employeeId: string; code: string; name: string; status: string; pin?: string; note?: string }[] = []
    let added = 0
    const toCreate: { vendorId: string; deviceId: string; employeeId: string; deviceUserId: string }[] = []
    for (const e of employees) {
      const reg = registered.get(e.id)
      if (reg) { results.push({ employeeId: e.id, code: e.code, name: e.fullName, status: "ALREADY_REGISTERED", pin: reg }); continue }
      const pin = pinFor(e.code)
      toCreate.push({ vendorId: ctx.vendorId, deviceId: d.id, employeeId: e.id, deviceUserId: pin })
      results.push({ employeeId: e.id, code: e.code, name: e.fullName, status: "ADDED", pin })
      added++
    }

    if (toCreate.length) {
      await db.$transaction(toCreate.map((m) => db.attendanceDeviceUser.create({ data: m })))
    }

    // queue the roster sync (skip when one is already pending for this device)
    let queued = false
    if (added > 0) {
      const pending = await db.deviceCommand.findFirst({
        where: { deviceId: d.id, command: "DATA UPDATE USERINFO", status: "QUEUED" },
      })
      if (!pending) {
        await db.deviceCommand.create({
          data: { vendorId: ctx.vendorId, deviceId: d.id, command: "DATA UPDATE USERINFO", createdBy: ctx.userId },
        })
        queued = true
      } else {
        queued = true // an update is already on its way — nothing lost
      }
    }

    await audit(ctx, "devices.pushEmployees", "AttendanceDeviceUser", d.id,
      `Pushed ${added} new employee(s) to device ${d.name} (SN ${d.deviceIdentifier}) — ${results.length - added} already registered${added ? "; DATA UPDATE USERINFO queued" : ""}`,
      { newValue: { added, total: results.length } })

    return {
      device: { id: d.id, name: d.name, sn: d.deviceIdentifier },
      added,
      alreadyRegistered: results.length - added,
      commandQueued: queued,
      results,
      note: added
        ? `The device picks up the roster on its next poll (LOGDELAY). ${added} user(s) queued for sync.`
        : "Every in-scope employee is already registered on this device.",
    }
  },
})

// ---------- test connection: queue a CHECK command (§6) ----------
route("devices.test", {
  perm: ["devices", "process"],
  handler: async (ctx, p) => {
    const d = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    const cmd = await db.deviceCommand.create({
      data: { vendorId: ctx.vendorId, deviceId: d.id, command: "CHECK", createdBy: ctx.userId },
    })
    await audit(ctx, "devices.test", "AttendanceDevice", d.id, `Queued CHECK command for ${d.name} — device consumes it on its next poll`)
    return { command: cmd.command, note: "The device polls for commands periodically (LOGDELAY). Watch Device Details → Commands for the result." }
  },
})

// ---------- R8: historical backfill — sync & pull OLD attendance data ----------
// Ongoing pushes only carry fresh punches (the ingest freshness window rejects
// anything older than HRM_DEVICE_INGEST_WINDOW_DAYS, default 7). This action
// opens a temporary WIDENED window per device and asks the terminal to
// re-upload old records from its local storage:
//
//   mode "CHECK" (default, universally supported) — device re-uploads every
//     record it has not confirmed as delivered. Best for: device was offline,
//     server was down/misconfigured, or logs were never confirmed.
//   mode "DATA_QUERY" (newer ZKTeco firmwares) — asks the device to return
//     ATTLOG records for an explicit StartTime/EndTime range.
//
// While the window is active (historySyncUntil, 60 minutes), punches older
// than the default window are accepted, deduplicated by payload hash (the
// device re-sending already-stored events is a no-op), and processed into
// daily attendance by the normal pipeline. The window expires automatically.
route("devices.syncHistory", {
  perm: ["devices", "process"],
  handler: async (ctx, p) => {
    const d = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    if (!d.enabled) throw new Deny("Device is disabled — enable it first", 400)

    const mode = p.mode === "DATA_QUERY" ? "DATA_QUERY" : "CHECK"
    const ISO = /^\d{4}-\d{2}-\d{2}$/
    const fromDate = typeof p.fromDate === "string" && ISO.test(p.fromDate) ? p.fromDate : null
    const toDate = typeof p.toDate === "string" && ISO.test(p.toDate) ? p.toDate : null
    if (mode === "DATA_QUERY" && !fromDate) {
      throw new Deny("DATA QUERY mode needs a from-date (the range the device should re-upload)", 400)
    }

    // widened lookback: from fromDate back to today, else 365 days; clamped to [7, 3650]
    let windowDays = 365
    if (fromDate) {
      const days = Math.ceil((Date.now() - new Date(fromDate + "T00:00:00Z").getTime()) / 86_400_000) + 1
      windowDays = days
    }
    windowDays = Math.min(3650, Math.max(7, windowDays))

    // build the command line
    let command = "CHECK"
    if (mode === "DATA_QUERY") {
      const start = fromDate + " 00:00:00"
      const end = (toDate ? new Date(toDate + "T00:00:00Z") : new Date()).toISOString().slice(0, 10) + " 23:59:59"
      // ADMS wire format: the two range parameters are TAB-separated
      command = `DATA QUERY ATTLOG StartTime=${start}\tEndTime=${end}`
    }
    if (!isAllowedCommand(command)) throw new Deny("Refusing to queue a non-whitelisted command", 400)

    // 2026-10 historical-sync fix — the widened window stays open for 24 HOURS
    // (was 60 minutes): large backfills easily exceed an hour of batched
    // uploads on the device's LOGDELAY cadence, and once the window expired
    // every remaining old punch was rejected again (and, before the
    // durable-store fix, lost for good). 24h covers overnight re-uploads;
    // admins can always close it early with devices.syncHistory.stop.
    const WINDOW_HOURS = Math.min(72, Math.max(1, Number(process.env.HRM_HISTORY_SYNC_WINDOW_HOURS) || 24))
    const until = new Date(Date.now() + WINDOW_HOURS * 3600_000)

    // 2026-10 historical-sync root cause fix — BEFORE asking the device for
    // anything, requeue every quarantined OUT_OF_WINDOW event already stored
    // for this device (they were durably kept instead of dropped). This makes
    // historical sync work even for firmware that ignores DATA QUERY and has
    // already ACKed-and-purged its local logs: anything the device ever
    // pushed is recovered from the server-side quarantine.
    const oowWhere: any = { vendorId: ctx.vendorId, deviceId: d.id, processingStatus: "OUT_OF_WINDOW" }
    if (fromDate || toDate) {
      oowWhere.eventTime = {}
      if (fromDate) oowWhere.eventTime.gte = fromDate + " 00:00:00"
      if (toDate) oowWhere.eventTime.lte = toDate + " 23:59:59"
    }
    const requeued = await db.attendanceRawEvent.updateMany({
      where: oowWhere,
      data: { processingStatus: "RECEIVED", processingError: null },
    }).catch(() => ({ count: 0 }) as { count: number })

    const [, cmd] = await db.$transaction([
      db.attendanceDevice.update({
        where: { id: d.id },
        data: { historySyncUntil: until, historySyncWindowDays: windowDays },
      }),
      db.deviceCommand.create({
        data: { vendorId: ctx.vendorId, deviceId: d.id, command, createdBy: ctx.userId },
      }),
    ])
    await audit(ctx, "devices.syncHistory", "AttendanceDevice", d.id,
      `Historical sync started for ${d.name} — mode ${mode}${fromDate ? ` (${fromDate} → ${toDate || "today"})` : ""}, widened ingest window ${windowDays} day(s), active until ${until.toISOString()}${requeued.count ? `, ${requeued.count} quarantined out-of-window event(s) requeued` : ""}`)
    return {
      command: cmd.command,
      windowDays,
      activeUntil: until.toISOString(),
      requeuedOutOfWindow: requeued.count,
      note: "Recovered storage first: " +
        (requeued.count
          ? `${requeued.count} previously rejected out-of-window punch(es) were already stored server-side and have been requeued for processing now. `
          : "no quarantined punches were waiting server-side. ") +
        "The device consumes the command on its next poll (LOGDELAY, usually ≤60s) and re-uploads its stored logs. " +
        "Re-uploaded punches are deduplicated automatically — records already in the system are never double-counted. " +
        "Watch Device Details → Commands and the Sync Monitor for progress. The widened window stays open for " +
        `${WINDOW_HOURS} hour(s) and can be closed early anytime.`,
    }
  },
})

// ---------- R8: stop an active historical sync early (restore the narrow window) ----------
route("devices.syncHistory.stop", {
  perm: ["devices", "process"],
  handler: async (ctx, p) => {
    const d = await db.attendanceDevice.findFirst({ where: { id: p.id, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    await db.attendanceDevice.update({
      where: { id: d.id },
      data: { historySyncUntil: null, historySyncWindowDays: null },
    })
    await audit(ctx, "devices.syncHistory.stop", "AttendanceDevice", d.id, `Historical sync window closed early for ${d.name}`)
    return { stopped: true }
  },
})

// ---------- raw event browser (spec §22) ----------
route("devices.events", {
  perm: ["devices", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    const scopedDevices = await db.attendanceDevice.findMany({ where: deviceScopeFilter(ctx), select: { id: true } })
    const scopedIds = scopedDevices.map((d) => d.id)
    where.deviceId = p.deviceId ? p.deviceId : { in: scopedIds }
    if (p.deviceId && !scopedIds.includes(p.deviceId)) throw new Deny("Device not in your scope", 403)
    if (p.employeeId) where.employeeId = p.employeeId
    if (p.processingStatus) where.processingStatus = p.processingStatus
    if (p.unknownOnly) where.processingStatus = "UNKNOWN_EMPLOYEE"
    if (p.dateFrom || p.dateTo) {
      where.eventTime = {}
      if (p.dateFrom) where.eventTime.gte = p.dateFrom + " 00:00:00"
      if (p.dateTo) where.eventTime.lte = p.dateTo + " 23:59:59"
    }
    const page = Number(p?.page || 1), size = Math.min(Number(p?.size || 50), 200)
    const [total, rows] = await Promise.all([
      db.attendanceRawEvent.count({ where }),
<<<<<<< HEAD
      db.attendanceRawEvent.findMany({ where, orderBy: [{ eventTime: "desc" }, { id: "asc" }], skip: (page - 1) * size, take: size }),
=======
      db.attendanceRawEvent.findMany({ where, orderBy: { eventTime: "desc" }, skip: (page - 1) * size, take: size }),
>>>>>>> origin/main
    ])
    const devices = await db.attendanceDevice.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, deviceIdentifier: true, branchId: true } })
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const empIds = [...new Set(rows.filter((r) => r.employeeId).map((r) => r.employeeId as string))]
    const employees = empIds.length ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } }) : []
    return {
      total, page, size,
      items: rows.map((e) => {
        const dev = devices.find((d) => d.id === e.deviceId)
        return {
          ...e,
          employeeName: employees.find((x) => x.id === e.employeeId)?.fullName || null,
          employeeCode: employees.find((x) => x.id === e.employeeId)?.code || null,
          deviceName: dev?.name || e.deviceSerial,
          branchName: branches.find((b) => b.id === dev?.branchId)?.name || null,
          verifyLabel: verifyModeLabel(e.verifyMode),
        }
      }),
    }
  },
})

// ---------- event detail: raw + normalized + related attendance (§22) ----------
route("devices.eventDetail", {
  perm: ["devices", "view"],
  handler: async (ctx, p) => {
    const ev = await db.attendanceRawEvent.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!ev) throw new Deny("Event not found", 404)
    const device = await db.attendanceDevice.findFirst({ where: { id: ev.deviceId } })
    const employee = ev.employeeId ? await db.employee.findFirst({ where: { id: ev.employeeId, vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true } }) : null
    const date = ev.eventTime.slice(0, 10)
    const attendance = ev.employeeId
      ? await db.attendance.findFirst({ where: { vendorId: ctx.vendorId, employeeId: ev.employeeId, date } })
      : null
    const history = await db.deviceCommLog.findMany({
      where: { deviceId: ev.deviceId, createdAt: { gte: new Date(Date.now() - 86400000) } },
      orderBy: { createdAt: "desc" }, take: 10,
    })
    return {
      raw: { ...ev, verifyLabel: verifyModeLabel(ev.verifyMode) },
      normalized: {
        device: device ? `${device.name} (SN ${device.deviceIdentifier})` : ev.deviceSerial,
        deviceUserId: ev.deviceUserId,
        employee: employee ? `${employee.fullName} (${employee.code})` : null,
        eventTime: ev.eventTime,
        eventType: ev.eventType,
        verifyMode: verifyModeLabel(ev.verifyMode),
        workCode: ev.workCode,
        processingStatus: ev.processingStatus,
        processingError: ev.processingError,
      },
      attendance,
      deviceHistory: history,
    }
  },
})

// ---------- reprocessing (spec §24 — idempotent) ----------
route("devices.reprocess", {
  perm: ["devices", "process"],
  handler: async (ctx, p) => {
    const res = await reprocessEvents(ctx.vendorId, {
      ids: p.ids, deviceId: p.deviceId, employeeId: p.employeeId,
      dateFrom: p.dateFrom, dateTo: p.dateTo, status: p.status, includeProcessed: !!p.includeProcessed,
    })
    await audit(ctx, "devices.reprocess", "AttendanceRawEvent", null,
      `Reprocessed ${res.matched} event(s): ${res.processed} processed, ${res.unknown} unknown, ${res.failed} failed — ${res.daysRebuilt} day(s) rebuilt`, { newValue: res })
    return res
  },
})

route("devices.recalculate", {
  perm: ["devices", "process"],
  handler: async (ctx, p) => {
    if (!p.employeeId || !p.dateFrom) throw new Deny("employeeId and dateFrom are required", 400)
    const res = await recalculateAttendance(ctx.vendorId, { employeeId: p.employeeId, dateFrom: p.dateFrom, dateTo: p.dateTo || p.dateFrom })
    await audit(ctx, "devices.recalculate", "Attendance", p.employeeId,
      `Recalculated attendance from raw device events: ${res.days} day(s) rebuilt (${p.dateFrom} → ${p.dateTo || p.dateFrom})`)
    return res
  },
})

// ---------- unknown device users (spec §11, §23) ----------
route("devices.unknownUsers", {
  perm: ["devices", "view"],
  handler: async (ctx) => unknownUsers(ctx.vendorId),
})

route("devices.mapUser", {
  perm: ["devices", "edit"],
  handler: async (ctx, p) => mapDeviceUser(ctx, p),
})

// 2026-10-07 — bulk automatic mapping: every unmapped device PIN whose
// Employee ID matches an HRM employee code is mapped; their parked punches
// are requeued and processed by the sweeper. Non-matching PINs stay listed
// for manual mapping.
route("devices.autoMap", {
  perm: ["devices", "edit"],
  handler: async (ctx, p) => {
    const scoped = await db.attendanceDevice.findMany({ where: deviceScopeFilter(ctx), select: { id: true } })
    const ids = scoped.map((d) => d.id)
    if (p?.deviceId && !ids.includes(p.deviceId)) throw new Deny("Device not in your scope", 403)
    const res = await autoMapAll(ctx.vendorId, p?.deviceId ? [p.deviceId] : ids)
    await audit(ctx, "devices.autoMap", "AttendanceDeviceUser", p?.deviceId || null,
      `Auto-mapped ${res.mapped} of ${res.considered} unmapped device user(s) by Employee ID`, { newValue: { mapped: res.mapped, considered: res.considered } })
    if (res.mapped > 0) {
      // process the requeued punches now instead of waiting for the sweeper
      await sweepOnce(ctx.vendorId).catch(() => null)
    }
    return { considered: res.considered, mapped: res.mapped, unmatched: res.results.filter((r) => r.status === "NO_MATCH").length, results: res.results }
  },
})

route("devices.unmap", {
  perm: ["devices", "edit"],
  handler: async (ctx, p) => unmapDeviceUser(ctx, p),
})

// ---------- mappings browser (spec §8) ----------
route("devices.mappings", {
  perm: ["devices", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.deviceId) {
      const dev = await db.attendanceDevice.findFirst({ where: { id: p.deviceId, ...deviceScopeFilter(ctx) } })
      if (!dev) throw new Deny("Device not in your scope", 403)
      where.deviceId = p.deviceId
    } else {
      // M-14 (re-ported R3-2) — no deviceId filter: constrain to the caller's
      // devices so a branch manager cannot list another branch's mappings
      // (parity with devices.events, which scopes the unfiltered list the
      // same way).
      const scoped = await scopedDeviceIds(ctx)
      if (scoped) where.deviceId = { in: scoped }
    }
    const list = await db.attendanceDeviceUser.findMany({ where, orderBy: { deviceUserId: "asc" } })
    const devices = await db.attendanceDevice.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true, status: true } })
    return list.map((m) => ({
      ...m,
      deviceName: devices.find((d) => d.id === m.deviceId)?.name || "—",
      employeeName: employees.find((e) => e.id === m.employeeId)?.fullName || "—",
      employeeCode: employees.find((e) => e.id === m.employeeId)?.code,
      employeeStatus: employees.find((e) => e.id === m.employeeId)?.status,
    }))
  },
})

// ---------- communication logs (spec §16) ----------
route("devices.commLogs", {
  perm: ["devices", "view"],
  // M-5 — comm logs are append-only, so CURSOR pagination is the default:
  // every response carries nextCursor (null = end); pass it back as `cursor`.
  // Callers that explicitly pass `page` get the legacy offset mode (total +
  // page) for jump-to-page UIs — still capped server-side.
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.deviceId) {
      // M-14 (re-ported R3-2) — the requested device must be inside the
      // caller's device scope (previously any deviceId was accepted
      // vendor-wide, handing a branch manager another branch's communication
      // history).
      const dev = await db.attendanceDevice.findFirst({ where: { id: p.deviceId, ...deviceScopeFilter(ctx) } })
      if (!dev) throw new Deny("Device not in your scope", 403)
      where.deviceId = p.deviceId
    } else {
      // M-14 (re-ported R3-2) — unfiltered browse: constrain to the caller's
      // devices. Logs whose deviceId is null (unattributable) stay visible
      // only to unscoped roles, exactly like before for admins.
      const scoped = await scopedDeviceIds(ctx)
      if (scoped) where.deviceId = { in: scoped }
    }
    if (p?.requestType) where.requestType = p.requestType
    if (p?.ok === false || p?.ok === "false") where.ok = false
    if (p?.cursor) where.id = { lt: p.cursor }
    const size = Math.min(Math.max(1, Number(p?.size) || 50), 200)
    const legacyPage = p?.cursor == null && p?.page != null
    const orderBy = [{ createdAt: "desc" }, { id: "desc" }] as const
    const devices = await db.attendanceDevice.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const nameOf = (deviceId: string | null, serial: string) => devices.find((d) => d.id === deviceId)?.name || serial
    if (legacyPage) {
      const page = Math.max(1, Number(p?.page) || 1)
      const [total, rows] = await Promise.all([
        db.deviceCommLog.count({ where }),
        db.deviceCommLog.findMany({ where, orderBy: [...orderBy], skip: (page - 1) * size, take: size }),
      ])
      return {
        total, page, size,
        items: rows.map((r) => ({ ...r, deviceName: nameOf(r.deviceId, r.serial) })),
        nextCursor: rows.length > 0 ? rows[rows.length - 1].id : null,
      }
    }
    const rows = await db.deviceCommLog.findMany({ where, orderBy: [...orderBy], take: size + 1 })
    const hasMore = rows.length > size
    const items = hasMore ? rows.slice(0, size) : rows
    return { items: items.map((r) => ({ ...r, deviceName: nameOf(r.deviceId, r.serial) })), nextCursor: hasMore ? items[items.length - 1].id : null, size }
  },
})

// ---------- sync monitor + manual sweep (spec §17, §33) ----------
route("devices.syncStats", {
  perm: ["devices", "view"],
  handler: async (ctx) => syncStats(ctx.vendorId),
})

route("devices.sweep", {
  perm: ["devices", "process"],
  handler: async (ctx) => {
    const res = await sweepOnce(ctx.vendorId)
    await audit(ctx, "devices.sweep", "AttendanceRawEvent", null, `Manual queue sweep: ${res.processed} processed, ${res.failed} failed`)
    return res
  },
})

// queue an arbitrary whitelisted command (admin tooling)
route("devices.queueCommand", {
  perm: ["devices", "edit"],
  handler: async (ctx, p) => {
    if (!isAllowedCommand(String(p.command || ""))) throw new Deny("Command not allowed", 400)
    const d = await db.attendanceDevice.findFirst({ where: { id: p.deviceId, ...deviceScopeFilter(ctx) } })
    if (!d) throw new Deny("Device not found in your scope", 404)
    // L-15 — destructive commands (CLEAR DATA / CLEAR LOG / REBOOT) require a
    // typed confirmation of the device SERIAL (same pattern as employees
    // .hardDelete): an accidental devices.edit must not irreversibly wipe a
    // terminal. The SN forces the operator to identify the exact device.
    const DESTRUCTIVE_COMMANDS = ["CLEAR DATA", "CLEAR LOG", "REBOOT"]
    const cmdText = String(p.command).trim().toUpperCase()
    if (DESTRUCTIVE_COMMANDS.includes(cmdText) && p.confirm !== d.deviceIdentifier) {
      throw new Deny(`Confirmation required — type the device serial (${d.deviceIdentifier}) to queue ${cmdText}.`, 400)
    }
    const cmd = await db.deviceCommand.create({
      data: { vendorId: ctx.vendorId, deviceId: d.id, command: String(p.command).trim().toUpperCase(), createdBy: ctx.userId },
    })
    await audit(ctx, "devices.queueCommand", "DeviceCommand", cmd.id, `Queued ${cmd.command} for ${d.name}`)
    return cmd
  },
})

// ---------- rebuild a single day (helper for corrections interplay) ----------
route("devices.rebuildDay", {
  perm: ["devices", "process"],
  handler: async (ctx, p) => {
    if (!p.employeeId || !p.date) throw new Deny("employeeId and date are required", 400)
    const res = await rebuildDaily(ctx.vendorId, p.employeeId, p.date)
    await audit(ctx, "devices.rebuildDay", "Attendance", `${p.employeeId}:${p.date}`, `Rebuilt ${p.date} from raw events (touched: ${res.touched})`)
    return res
  },
})

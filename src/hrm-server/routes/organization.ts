// ============ Organization routes: branches, departments, designations, holidays,
// shifts, rosters, approval workflow config, settings, company events ============
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, employeeScopeFilter } from "../rbac"
import { audit } from "../audit"
import { getSettings, saveSettingsGroup, SETTINGS_SAVE_GROUPS } from "../settings"
import { workflowsWithSteps } from "../approval"
import { requireCapacity } from "../saas/entitlements"

// Sanitize form payloads: FormDialog submits "" for untouched fields, but
// Prisma rejects empty strings for Float/Int/DateTime/relational columns.
// Convention: empty string/undefined = "not provided" → drop the key.
const stripEmpty = (d: any) => {
  const out: any = {}
  for (const [k, v] of Object.entries(d || {})) {
    if (v === "") continue
    out[k] = v
  }
  return out
}

const CRUD = (model: keyof typeof db, permModule: string, entity: string, listName = entity.toLowerCase(), clean: (d: any) => any = stripEmpty) => {
  route(`${listName}.list`, {
    perm: [permModule, "view"],
    handler: async (ctx, p) => {
      const where: any = { vendorId: ctx.vendorId }
      if (p?.active !== undefined) where.active = p.active
      if (entity === "Department" && p?.branchId) where.branchId = p.branchId
      return (db as any)[model].findMany({ where, orderBy: { createdAt: "asc" } })
    },
  })

  // ---------- Auto-generate next code ----------
  // GET /{listName}.nextCode → { code: "BR-0007" } (or DEPT-0007 / DESIG-0007)
  // Pattern: <PREFIX>-<4-digit-zero-padded-sequence>. Sequence is computed
  // from the count of existing records + 1, and is guaranteed unique by
  // scanning until an unused code is found.
  route(`${listName}.nextCode`, {
    perm: [permModule, "view"],
    handler: async (ctx) => {
      const prefix =
        entity === "Branch" ? "BR" :
        entity === "Department" ? "DEPT" :
        entity === "Designation" ? "DESIG" :
        entity === "Shift" ? "SH" :
        entity.toUpperCase().slice(0, 3)
      const existing = await (db as any)[model].findMany({
        where: { vendorId: ctx.vendorId },
        select: { code: true },
      })
      const used = new Set(existing.map((r: any) => r.code))
      let n = 1
      while (used.has(`${prefix}-${String(n).padStart(4, "0")}`)) n++
      return { code: `${prefix}-${String(n).padStart(4, "0")}` }
    },
  })

  route(`${listName}.create`, {
    perm: [permModule, "create"],
    handler: async (ctx, p) => {
      // SaaS plan capacity — Branch/Department seats (LEGACY tenants pass)
      if (entity === "Branch") await requireCapacity(ctx.vendorId, "BRANCHES", 1)
      if (entity === "Department") await requireCapacity(ctx.vendorId, "DEPARTMENTS", 1)
      // Auto-generate code if not provided
      let code = p?.code
      if (!code || String(code).trim() === "") {
        const prefix =
          entity === "Branch" ? "BR" :
          entity === "Department" ? "DEPT" :
          entity === "Designation" ? "DESIG" :
          entity === "Shift" ? "SH" :
          entity.toUpperCase().slice(0, 3)
        const existing = await (db as any)[model].findMany({
          where: { vendorId: ctx.vendorId },
          select: { code: true },
        })
        const used = new Set(existing.map((r: any) => r.code))
        let n = 1
        while (used.has(`${prefix}-${String(n).padStart(4, "0")}`)) n++
        code = `${prefix}-${String(n).padStart(4, "0")}`
      }
      const data = clean({ ...p, code, vendorId: ctx.vendorId })
      delete data.id // H-5 — never persist a caller-supplied primary key
      delete data.status
      const rec = await (db as any)[model].create({ data })
      await audit(ctx, `${entity.toLowerCase()}.create`, entity, rec.id, `Created ${p?.name || code}`)
      return rec
    },
  })
  route(`${listName}.update`, {
    perm: [permModule, "edit"],
    handler: async (ctx, p) => {
      const existing = await (db as any)[model].findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Not found", 404)
      const data = clean({ ...p })
      delete data.id
      delete data.vendorId
      const rec = await (db as any)[model].update({ where: { id: p.id }, data })
      await audit(ctx, `${entity.toLowerCase()}.update`, entity, p.id, `Updated ${p?.name || p.id}`, { oldValue: existing, newValue: data })
      return rec
    },
  })
  route(`${listName}.delete`, {
    perm: [permModule, "delete"],
    handler: async (ctx, p) => {
      const existing = await (db as any)[model].findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Not found", 404)
      // guard: block delete when employees reference it
      if (entity === "Branch") {
        const c = await db.employee.count({ where: { vendorId: ctx.vendorId, branchId: p.id } })
        if (c > 0) throw new Deny(`Cannot delete: ${c} employee(s) assigned to this branch. Transfer them first.`)
      }
      if (entity === "Department") {
        const c = await db.employee.count({ where: { vendorId: ctx.vendorId, departmentId: p.id } })
        if (c > 0) throw new Deny(`Cannot delete: ${c} employee(s) in this department.`)
      }
      if (entity === "Designation") {
        const c = await db.employee.count({ where: { vendorId: ctx.vendorId, designationId: p.id } })
        if (c > 0) throw new Deny(`Cannot delete: ${c} employee(s) hold this designation.`)
      }
      await (db as any)[model].delete({ where: { id: p.id } })
      await audit(ctx, `${entity.toLowerCase()}.delete`, entity, p.id, `Deleted ${existing.name}`, { oldValue: existing })
      return { deleted: true }
    },
  })
}

CRUD("branch", "organization", "Branch", "branches")
CRUD("department", "organization", "Department", "departments")
CRUD("designation", "organization", "Designation", "designations")
CRUD("shift", "shifts", "Shift", "shifts")

// ---------- Holidays ----------
route("holidays.list", {
  perm: ["organization", "view"],
  handler: async (ctx, p) => {
    return db.holiday.findMany({
      where: { vendorId: ctx.vendorId, ...(p?.year ? { date: { startsWith: String(p.year) } } : {}) },
      orderBy: { date: "asc" },
    })
  },
})
route("holidays.create", {
  perm: ["organization", "create"],
  handler: async (ctx, p) => {
    const rec = await db.holiday.create({ data: { vendorId: ctx.vendorId, name: p.name, date: p.date, type: p.type || "PUBLIC", branchId: p.branchId || null } })
    await audit(ctx, "holidays.create", "Holiday", rec.id, `${p.name} on ${p.date}`)
    return rec
  },
})
route("holidays.delete", {
  perm: ["organization", "delete"],
  handler: async (ctx, p) => {
    const rec = await db.holiday.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    await db.holiday.delete({ where: { id: p.id } })
    await audit(ctx, "holidays.delete", "Holiday", p.id, `Deleted ${rec.name}`)
    return { deleted: true }
  },
})

// ---------- Holidays — bulk import (Excel/CSV) ----------
// The client parses the file and previews rows; the SERVER re-validates
// everything (never trust client validation) and inserts in one transaction.
// Rows are accepted as objects { name, date, type, branchName } — date must be
// ISO (YYYY-MM-DD), type one of PUBLIC|OPTIONAL|COMPANY, branchName is resolved
// against the vendor's branches (blank/unknown = all branches).
route("holidays.bulkCreate", {
  perm: ["organization", "create"],
  handler: async (ctx, p) => {
    const rows: any[] = Array.isArray(p?.rows) ? p.rows : []
    if (rows.length === 0) throw new Deny("No rows to import", 400)
    if (rows.length > 1000) throw new Deny("Too many rows (max 1000 per import)", 400)

    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const branchByName = new Map(branches.map((b) => [b.name.toLowerCase(), b.id]))

    // existing holidays for the tenant (any year in the file) for duplicate detection
    const years = [...new Set(rows.map((r) => String(r?.date || "").slice(0, 4)).filter(Boolean))]
    const existing = years.length
      ? await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: years[0] } } })
      : []
    if (years.length > 1) {
      // fetch each referenced year only (keeps the query small for multi-year files)
      const more = await Promise.all(years.slice(1).map((y) =>
        db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: y } } })))
      existing.push(...more.flat())
    }
    const existingKeys = new Set(existing.map((h) => `${h.date}|${h.branchId || ""}`))

    const valid: { name: string; date: string; type: string; branchId: string | null }[] = []
    const errors: { row: number; name?: string; reason: string }[] = []
    const seen = new Set<string>()
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {}
      const name = String(r.name || "").trim().slice(0, 120)
      const date = String(r.date || "").trim()
      const typeRaw = String(r.type || "PUBLIC").trim().toUpperCase()
      const branchRaw = String(r.branchName || "").trim()
      const rowNo = Number(r.rowNo || i + 2) // +1 header, +1 1-based
      if (!name) { errors.push({ row: rowNo, reason: "holiday name is missing" }); continue }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push({ row: rowNo, name, reason: `invalid date "${date || "—"}" — expected YYYY-MM-DD` }); continue }
      const d = new Date(date + "T00:00:00")
      if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) { errors.push({ row: rowNo, name, reason: `invalid calendar date "${date}"` }); continue }
      const type = ["PUBLIC", "OPTIONAL", "COMPANY"].includes(typeRaw) ? typeRaw : ""
      if (!type) { errors.push({ row: rowNo, name, reason: `invalid type "${typeRaw}" — use PUBLIC, OPTIONAL or COMPANY` }); continue }
      let branchId: string | null = null
      if (branchRaw) {
        branchId = branchByName.get(branchRaw.toLowerCase()) || null
        if (!branchId) { errors.push({ row: rowNo, name, reason: `unknown branch "${branchRaw}" — leave blank for all branches` }); continue }
      }
      const key = `${date}|${branchId || ""}`
      if (seen.has(key)) { errors.push({ row: rowNo, name, reason: "duplicate row in this file (same date + branch)" }); continue }
      if (existingKeys.has(key)) { errors.push({ row: rowNo, name, reason: "a holiday already exists for this date + branch" }); continue }
      seen.add(key)
      valid.push({ name, date, type, branchId })
    }

    // safe transaction-based insertion — all-or-nothing is NOT forced here by
    // design: valid rows insert, invalid rows are reported. But the insert itself
    // is atomic so a partial DB failure can never leave half a file behind.
    if (valid.length) {
      await db.$transaction(valid.map((v) => db.holiday.create({
        data: { vendorId: ctx.vendorId, name: v.name, date: v.date, type: v.type, branchId: v.branchId },
      })))
    }
    await audit(ctx, "holidays.bulkCreate", "Holiday", null,
      `Bulk holiday import: ${valid.length} inserted, ${errors.length} rejected (${rows.length} rows)`,
      { newValue: { inserted: valid.length, rejected: errors.length } })
    return { inserted: valid.length, rejected: errors.length, errors: errors.slice(0, 200), insertedRows: valid }
  },
})

// ---------- Shift roster ----------
route("rosters.list", {
  perm: ["shifts", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.fromDate) where.fromDate = { gte: p.fromDate }
    if (p?.employeeId) where.employeeId = p.employeeId
    const list = await db.shiftAssignment.findMany({ where, orderBy: { fromDate: "desc" }, take: 200 })
    const shifts = await db.shift.findMany({ where: { vendorId: ctx.vendorId } })
    const emps = await db.employee.findMany({ where: employeeScopeFilter(ctx), select: { id: true, fullName: true, code: true } })
    return list.map((a) => ({
      ...a,
      employeeName: emps.find((e) => e.id === a.employeeId)?.fullName || "—",
      employeeCode: emps.find((e) => e.id === a.employeeId)?.code,
      shiftName: shifts.find((s) => s.id === a.shiftId)?.name || "—",
    }))
  },
})
route("rosters.assign", {
  perm: ["shifts", "assign"],
  handler: async (ctx, p) => {
    const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    // ATT-011 — the target shift must belong to THIS tenant: a foreign-tenant
    // shift id used to be accepted silently and then drove attendance math
    // through the (now vendor-scoped) resolveShift, hiding the bad reference
    const shift = await db.shift.findFirst({ where: { id: p.shiftId, vendorId: ctx.vendorId } })
    if (!shift) throw new Deny("Shift not found in this organization", 404)
    const rec = await db.shiftAssignment.create({
      data: { vendorId: ctx.vendorId, employeeId: p.employeeId, shiftId: p.shiftId, fromDate: p.fromDate, toDate: p.toDate || null, note: p.note || null, createdBy: ctx.userId },
    })
    await audit(ctx, "rosters.assign", "ShiftAssignment", rec.id, `Roster: ${emp.fullName} from ${p.fromDate}`)
    return rec
  },
})
route("rosters.delete", {
  perm: ["shifts", "delete"],
  handler: async (ctx, p) => {
    const rec = await db.shiftAssignment.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    await db.shiftAssignment.delete({ where: { id: p.id } })
    await audit(ctx, "rosters.delete", "ShiftAssignment", p.id, "Roster removed")
    return { deleted: true }
  },
})

// ---------- Shift definitions (Attendance → Shifts tab) ----------
// FIX: the frontend has always called shifts.list/create/update/delete but no
// route file registered them — the Shifts tab silently showed a 404 banner.
route("shifts.list", {
  perm: ["shifts", "view"],
  handler: async (ctx) => {
    const list = await db.shift.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "asc" } })
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
    return list.map((s) => ({ ...s, branchName: branches.find((b) => b.id === s.branchId)?.name || null }))
  },
})

// Weekly-off days are stored as an uppercase comma list ("FRIDAY,SATURDAY").
// Accepts an array (multiselect UI) or a comma/space separated string and
// validates day names — every consumer (payroll, leave, reports, roadmap,
// exit, daily jobs) already splits the stored value into a day list.
const WEEK_DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
function normalizeWeeklyOff(v: unknown): string {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/)
  const days = [...new Set(raw.map((d: string) => String(d).trim().toUpperCase()).filter((d: string) => (WEEK_DAYS as string[]).includes(d)))]
  return days.length ? days.join(",") : "FRIDAY"
}

route("shifts.create", {
  perm: ["shifts", "edit"],
  handler: async (ctx, p) => {
    if (!p.name || !p.startTime || !p.endTime) throw new Deny("Name, start time and end time are required")
    const rec = await db.shift.create({
      data: {
        vendorId: ctx.vendorId, name: p.name, type: p.type || "FIXED",
        startTime: p.startTime, endTime: p.endTime,
        graceMinutes: Number(p.graceMinutes ?? 10), breakMinutes: Number(p.breakMinutes ?? 60),
        minWorkingHours: Number(p.minWorkingHours ?? 8),
        otThresholdMinutes: Number(p.otThresholdMinutes ?? 30),
        otMultiplier: Number(p.otMultiplier ?? 1.5),
        otHolidayMultiplier: Number(p.otHolidayMultiplier ?? 2),
        otWeeklyOffMultiplier: Number(p.otWeeklyOffMultiplier ?? 2),
        weeklyOff: normalizeWeeklyOff(p.weeklyOff), branchId: p.branchId || null, active: p.active !== false,
      },
    })
    await audit(ctx, "shifts.create", "Shift", rec.id, `Created shift ${rec.name} (${rec.startTime}–${rec.endTime})`)
    return rec
  },
})
route("shifts.update", {
  perm: ["shifts", "edit"],
  handler: async (ctx, p) => {
    const existing = await db.shift.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Shift not found", 404)
    const data: any = {}
    for (const k of ["name", "type", "startTime", "endTime"]) if (p[k] !== undefined) data[k] = p[k]
    if (p.weeklyOff !== undefined) data.weeklyOff = normalizeWeeklyOff(p.weeklyOff)
    for (const k of ["graceMinutes", "breakMinutes", "minWorkingHours", "otThresholdMinutes", "otMultiplier", "otHolidayMultiplier", "otWeeklyOffMultiplier"]) {
      if (p[k] !== undefined && p[k] !== "") data[k] = Number(p[k])
    }
    if (p.branchId !== undefined) data.branchId = p.branchId || null
    if (p.active !== undefined) data.active = !!p.active
    const rec = await db.shift.update({ where: { id: p.id }, data })
    await audit(ctx, "shifts.update", "Shift", p.id, `Updated shift ${rec.name}`, { oldValue: existing, newValue: data })
    return rec
  },
})
route("shifts.delete", {
  perm: ["shifts", "delete"],
  handler: async (ctx, p) => {
    const existing = await db.shift.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Shift not found", 404)
    const inUse = await db.employee.count({ where: { vendorId: ctx.vendorId, shiftId: p.id } })
    if (inUse > 0) throw new Deny(`${inUse} employee(s) still use this shift — reassign them first`)
    await db.shiftAssignment.deleteMany({ where: { vendorId: ctx.vendorId, shiftId: p.id } })
    await db.shift.delete({ where: { id: p.id } })
    await audit(ctx, "shifts.delete", "Shift", p.id, `Deleted shift ${existing.name}`)
    return { deleted: true }
  },
})

// ---------- Settings ----------
route("settings.get", {
  perm: ["settings", "view"],
  handler: async (ctx) => getSettings(ctx.vendorId),
})
route("settings.save", {
  perm: ["settings", "edit"],
  handler: async (ctx, p) => {
    // H-2 — the whitelist now derives from DEFAULT_SETTINGS (settings.ts)
    // via SETTINGS_SAVE_GROUPS: the essPortal group (R5) shipped in defaults
    // and UI but was missing from the previous inline copies, making the
    // Self-Service Portal tab permanently unsavable. One shared registry
    // makes schema/whitelist drift structurally impossible.
    const groups = SETTINGS_SAVE_GROUPS
    if (!groups.includes(p.group)) throw new Deny("Unknown settings group")
    // 2026-10-25 (master prompt Part C §6): the REGISTERED PLATFORM TENANT
    // NAME (Vendor.name) is owner-controlled. Tenant users can never change
    // it through this (or any) settings mutation — companyName is stripped
    // server-side and the Vendor.name mirror is removed. legalName, address,
    // phone, email, logo and the signatory fields remain tenant-editable.
    if (p.group === "general" && p.values && typeof p.values === "object") {
      const { companyName: _companyName, ...rest } = p.values as Record<string, unknown>
      p.values = rest
    }
    await saveSettingsGroup(ctx.vendorId, p.group, p.values || {})
    // Company profile lives in Settings and mirrors onto the Vendor record so
    // the login shell / letterheads stay in sync with one source of truth.
    // (companyName is DELIBERATELY absent — see the Part C note above.)
    if (p.group === "general") {
      const g = p.values || {}
      const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
      if (vendor) {
        const legalName = typeof g.legalName === "string" && g.legalName.trim() ? g.legalName.trim() : null
        await db.vendor.update({
          where: { id: ctx.vendorId },
          data: {
            legalName,
            address: typeof g.address === "string" && g.address.trim() ? g.address.trim() : null,
            phone: typeof g.phone === "string" && g.phone.trim() ? g.phone.trim() : null,
            email: typeof g.email === "string" && g.email.trim() ? g.email.trim() : null,
            logoUrl: typeof g.logoUrl === "string" ? (g.logoUrl.trim() || null) : vendor.logoUrl,
            // letter signatory mirrors (spec §13.5) — Vendor is the render-time source
            signatoryName: typeof g.signatoryName === "string" && g.signatoryName.trim() ? g.signatoryName.trim() : null,
            signatoryDesignation: typeof g.signatoryDesignation === "string" && g.signatoryDesignation.trim() ? g.signatoryDesignation.trim() : null,
            signatureUrl: typeof g.signatureUrl === "string" ? (g.signatureUrl.trim() || null) : vendor.signatureUrl,
            sealUrl: typeof g.sealUrl === "string" ? (g.sealUrl.trim() || null) : vendor.sealUrl,
          },
        })
      }
    }
    await audit(ctx, "settings.edit", "HrSetting", p.group, `Updated ${p.group} settings`, { newValue: p.values })
    return getSettings(ctx.vendorId)
  },
})

// L-13 — explicit PARTIAL-update endpoint for settings. settings.save +
// saveSettingsGroup already upsert per-key (a group is stored as individual
// (group,key) rows), but the old language switcher worked around that with a
// client-side read-modify-write (fetch the whole group, spread, save it all
// back) — a clobber race whenever two tabs patched different keys of the same
// group. settings.patch documents and guarantees the merge semantics: send
// ONLY the changed keys; the server merges them into the stored group.
route("settings.patch", {
  perm: ["settings", "edit"],
  handler: async (ctx, p) => {
    // H-2 — same shared registry as settings.save (see note above).
    const groups = SETTINGS_SAVE_GROUPS
    if (!groups.includes(p.group)) throw new Deny("Unknown settings group")
    const patch = (p.values || {}) as Record<string, unknown>
    // 2026-10-25 (master prompt Part C §6): companyName is owner-controlled —
    // the same server-side strip as settings.save applies to patches.
    if (p.group === "general") delete patch.companyName
    if (Object.keys(patch).length === 0) throw new Deny("settings.patch requires at least one key in values")
    await saveSettingsGroup(ctx.vendorId, p.group, patch)
    // Patch is key-scoped on purpose: it NEVER triggers the general→Vendor
    // mirror (that path rewrites company profile fields and belongs to the
    // full-group save flow in settings.save).
    await audit(ctx, "settings.patch", "HrSetting", `${ctx.vendorId}:${p.group}`, `Patched settings group "${p.group}" keys: ${Object.keys(patch).join(", ")}`)
    return { ok: true }
  },
})

// ---------- Approval workflow configuration ----------
route("workflows.list", {
  perm: ["settings", "view"],
  handler: async (ctx) => workflowsWithSteps(ctx.vendorId),
})
route("workflows.save", {
  perm: ["settings", "edit"],
  handler: async (ctx, p) => {
    const { processType, name, steps } = p
    // ---- MOD-14 (Phase 4) — two structural hazards fixed:
    // (1) PENDING requests of this process type block the edit: the old path
    //     silently detached every in-flight approval from its step
    //     definitions (the rewrite replaced the steps the running requests
    //     were sitting on), leaving them approvable against steps that no
    //     longer existed.
    // (2) the whole rewrite (upsert + wipe + createMany) is ONE transaction:
    //     the old non-transactional sequence (upsert → deleteMany ALL steps
    //     → sequential per-step creates) left the workflow with zero or
    //     partial steps on a mid-failure, and every in-flight approval of
    //     that type hung.
    const pendingOfKind = await db.approvalRequest.count({
      where: { vendorId: ctx.vendorId, processType, status: "PENDING" },
    })
    if (pendingOfKind > 0) {
      throw new Deny(
        `${pendingOfKind} pending ${processType.toLowerCase()} approval request(s) reference this workflow's steps — resolve or reject them before editing the workflow (an edit would detach running approvals from their step definitions).`,
        400,
      )
    }
    const wf = await db.$transaction(async (tx) => {
      let w = await tx.approvalWorkflow.findFirst({ where: { vendorId: ctx.vendorId, processType } })
      if (!w) {
        w = await tx.approvalWorkflow.create({ data: { vendorId: ctx.vendorId, processType, name } })
      } else {
        w = await tx.approvalWorkflow.update({ where: { id: w.id }, data: { name, active: p.active ?? true } })
      }
      const workflowId = w.id
      await tx.approvalStep.deleteMany({ where: { workflowId } })
      let seq = 1
      const rows = (steps || []).map((s: any) => ({
        vendorId: ctx.vendorId, // DB-02 (R5)
        workflowId, sequence: seq++, name: s.name,
        approverRole: s.approverRole || null, approverUserId: s.approverUserId || null,
        departmentScope: !!s.departmentScope, branchScope: !!s.branchScope,
        amountThreshold: s.amountThreshold != null ? Number(s.amountThreshold) : null,
        required: s.required !== false, rejectBehavior: s.rejectBehavior || "REJECT_ALL",
        allowDelegation: !!s.allowDelegation,
      }))
      if (rows.length) await tx.approvalStep.createMany({ data: rows })
      return w
    })
    await audit(ctx, "settings.edit", "ApprovalWorkflow", wf.id, `Saved ${processType} workflow (${steps?.length || 0} steps)`)
    return workflowsWithSteps(ctx.vendorId)
  },
})

// ---------- Company events ----------
route("events.list", {
  // M-02 — company events are org-wide announcements: view-gated.
  perm: ["announcements", "view"],
  handler: async (ctx, p) => {
    const y = p?.year || new Date().getFullYear()
    return db.companyEvent.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: String(y) } }, orderBy: { date: "asc" } })
  },
})
route("events.create", {
  perm: ["announcements", "create"],
  handler: async (ctx, p) => {
    const rec = await db.companyEvent.create({
      data: { vendorId: ctx.vendorId, title: p.title, type: p.type || "EVENT", date: p.date, time: p.time || null, description: p.description || null, branchId: p.branchId || null, createdBy: ctx.userId },
    })
    await audit(ctx, "events.create", "CompanyEvent", rec.id, `${p.title} on ${p.date}`)
    return rec
  },
})
route("events.delete", {
  perm: ["announcements", "delete"],
  handler: async (ctx, p) => {
    const rec = await db.companyEvent.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    await db.companyEvent.delete({ where: { id: p.id } })
    // Audit Low — calendar-event deletes were previously unaudited
    await audit(ctx, "events.delete", "CompanyEvent", p.id, `Deleted event ${rec.title}`, { oldValue: rec })
    return { deleted: true }
  },
})

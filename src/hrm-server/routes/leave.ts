// ============ Leave Management routes (spec §8) ============
// Types & policies, balances, requests with substitute system, approval via the
// reusable engine. Approved leave deducts balance AND writes attendance LEAVE rows
// so payroll consumes it.
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, employeeScopeFilter, assertEmployeeVisible, scopedEmployeeWhere , applyEmployeeSearch } from "../rbac"
import { audit, notify } from "../audit"
import { notifyChannels } from "../delivery"
import { getSettings } from "../settings"
import { encryptField, decryptField } from "../crypto-field"

/** R1-027 — encrypt leave attachment before storage; decrypt on download.
 *  Context: "pii::v1" (same context as employee documents). */
function encryptAttachment(b64: string): string {
  try { return encryptField(b64, "pii::v1") } catch { return b64 /* HRM_MFA_KEY missing: dev/test fallback */ }
}
function decryptAttachment(stored: string): string {
  try { return decryptField(stored, "pii::v1") } catch { return stored /* legacy plaintext or key missing */ }
}
import { webhookEmit } from "../webhooks"
import { addDays, cleanForm, dailyRate, daysBetween, j, leaveDaysBetween, today, EMPLOYEE_REF_SELECT, resolveWeeklyOffDays } from "../utils"
import { S } from "../validation"
import { requireCapacity, requireFeature , bumpStorageRollup } from "../saas/entitlements"
import { validateLeaveAttachment, sniffMime, decodeBase64Payload } from "../uploads"
import { spendableDays, entitledFloor, leaveYearOf, proRatedEntitlement } from "../leave-math"

// ---------- Leave types (with policy settings) ----------
route("leaveTypes.list", {
  perm: ["leave", "view"],
  handler: async (ctx) => db.leaveType.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { code: "asc" } }),
})
route("leaveTypes.save", {
  perm: ["settings", "edit"],
  handler: async (ctx, p) => {
    // whitelist: unknown keys would crash Prisma's create/update
    const allowed = ["code", "name", "paid", "defaultDays", "carryForward", "maxCarryForward",
      // HRM-011 — carry-forward depth + accrual frequency (editable from Settings → Leave)
      "carryForwardExpiryMonths", "accrualFrequency",
      // HRM-012 — encashment rules
      "encashmentAllowed", "encashmentRate", "encashmentCap",
      // Types & Policies dialog fields — dropping these made edits silently
      // revert on the next open ("saved" toast but old values shown back)
      "waitingPeriodDays", "probationEligible", "requiresAttachment", "active",
      // LVE-107 — gender-restricted eligibility (maternity/paternity)
      "genderRestriction"]
    const cleaned = cleanForm(p)
    const data: any = {}
    for (const k of allowed) if (cleaned[k] !== undefined) data[k] = cleaned[k]
    if (data.code) data.code = String(data.code).toUpperCase().trim()
    if (!data.code || !data.name) throw new Deny("Code and name are required")
    // LVE-107 — closed vocabulary; "" clears the restriction
    if (data.genderRestriction != null) {
      const g = String(data.genderRestriction).toUpperCase().trim()
      if (g !== "MALE" && g !== "FEMALE") data.genderRestriction = null
      else data.genderRestriction = g
    }
    if (p.id) {
      const existing = await db.leaveType.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Not found", 404)
      const rec = await db.leaveType.update({ where: { id: p.id }, data })
      await audit(ctx, "leaveTypes.update", "LeaveType", p.id, `Updated leave type ${data.name}`, { oldValue: existing, newValue: data })
      return rec
    }
    const rec = await db.leaveType.create({ data: { vendorId: ctx.vendorId, ...data } })
    await audit(ctx, "leaveTypes.create", "LeaveType", rec.id, `Created leave type ${data.name}`)
    return rec
  },
})

// ---------- Balances ----------
route("leaveBalances.recompute", {
  // LVE-008 (R3-4) — this is a MASS WRITE, not a view: gated on leave.edit
  // (previously leave.view — any read-only role could rewrite the whole
  // tenant's balances), executed per-employee inside a transaction (partial
  // failure can no longer leave a half-recomputed vendor), and the entitled
  // write never lowers below used + pending (a lowered defaultDays used to
  // silently push balances over-committed, corrupting exactly what the admin
  // self-check flags next).
  perm: ["leave", "edit"],
  handler: async (ctx, p) => {
    const year = p?.year || new Date().getFullYear()
    const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId, active: true } })
    const empWhere: any = employeeScopeFilter(ctx)
    empWhere.status = { in: ["ACTIVE", "PROBATION", "ON_LEAVE"] }
    const employees = await db.employee.findMany({ where: empWhere })
    let created = 0, floored = 0
    for (const emp of employees) {
      // LVE-008 — one transaction per employee: a failure rolls back that
      // employee's whole recompute (types are re-created/updated atomically).
      await db.$transaction(async (tx) => {
        for (const t of types) {
          const existing = await tx.leaveBalance.findFirst({ where: { employeeId: emp.id, leaveTypeId: t.id, year } })
          const committed = (existing?.used || 0) + (existing?.pending || 0)
          // LVE-002 (R3-4) — carriedForward stays in its OWN column. The old
          // `target = defaultDays + carriedForward` FOLDED the carry into
          // entitled, after which the admin context / quick-actions sheet /
          // self-check (which add carriedForward on top of entitled)
          // double-counted it. Entitlement now resets to defaultDays, floored
          // so spendable = entitled + carried − used − pending never goes
          // negative on an over-committed ledger (the floor binds when
          // defaultDays was lowered below what is already committed).
          const entitled = entitledFloor(t.defaultDays, committed, existing?.carriedForward || 0)
          if (!existing) {
            await tx.leaveBalance.create({ data: { vendorId: ctx.vendorId, employeeId: emp.id, leaveTypeId: t.id, year, entitled, used: 0, pending: 0, carriedForward: 0 } })
            created++
          } else if (entitled !== existing.entitled) {
            await tx.leaveBalance.update({ where: { id: existing.id }, data: { entitled } })
            if (entitled > t.defaultDays) floored++
          }
        }
      })
    }
    // Audit Low — mass balance writes must leave an audit trail
    await audit(ctx, "leaveBalances.recompute", "LeaveBalance", null,
      `Recomputed ${employees.length} employee balance row(s) for ${types.length} leave type(s), year ${year}${floored ? ` — ${floored} row(s) floored at used+pending (defaultDays lowered below committed balance; adjust the ledger manually if intentional)` : ""}`)
    return { employees: employees.length, types: types.length, year, created, floored }
  },
})

route("leaveBalances.list", {
  perm: ["leave", "view"],
  handler: async (ctx, p) => {
    const year = p?.year || new Date().getFullYear()
    const where: any = { vendorId: ctx.vendorId, year, ...await scopedEmployeeWhere(ctx, p) }
    // P6 WS-B — server-side search (q matches employee name/code, intersected
    // with the caller's scope — the SCL-10 discipline)
    await applyEmployeeSearch(ctx.vendorId, where, p?.q)
    // M-11 follow-up (P6 WS-B) — optional MOD-16 pagination (page/pageSize →
    // { items, total, page, pageSize } bounded at 500; legacy callers keep
    // the full-array contract). Was: EVERY balance row of the year (employees
    // × types) + the FULL tenant directory per request.
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [balances, total] = paged
      ? await Promise.all([
          db.leaveBalance.findMany({ where, skip: (page - 1) * pageSize, take: pageSize }),
          db.leaveBalance.count({ where }),
        ])
      : [await db.leaveBalance.findMany({ where }), null]
    const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId } })
    // M-11 — reference select: never haul base64 photo columns for a name join.
    // P6 WS-B — names resolve from the PAGE's ids via one whereIn (was: the
    // whole tenant directory per request).
    const empIds = [...new Set(balances.map((b) => b.employeeId))]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: EMPLOYEE_REF_SELECT })
      : []
    const empById = new Map(employees.map((e) => [e.id, e]))
    const items = balances.map((b) => {
      const t = types.find((x) => x.id === b.leaveTypeId)
      return {
        ...b,
        typeName: t?.name,
        typeCode: t?.code,
        paid: t?.paid,
        // LVE-007 (R3-4) — the encashment policy rides with the row so the
        // Balances tab can offer the (previously unreachable) encash action
        encashmentAllowed: !!(t as any)?.encashmentAllowed,
        employeeName: empById.get(b.employeeId)?.fullName || "—",
        // LVE-002 (R3-4) — the canonical formula (entitled + carried − used −
        // pending), shared with apply/ESS/encash/exit through leave-math.ts
        remaining: spendableDays(b),
      }
    })
    return paged ? { items, total, page, pageSize } : items
  },
})

// ---------- Requests ----------
route("leaveRequests.list", {
  perm: ["leave", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    if (p?.status) where.status = p.status
    if (p?.myTeam) {
      // manager inbox: requests of employees in scope
      const scope = employeeScopeFilter(ctx)
      where.employeeId = { in: (await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id) }
    }
    // MOD-16 (Phase 2 WS4) — optional server-side pagination: paged callers
    // (page/pageSize) get { items, total, page, pageSize } bounded at 500;
    // legacy callers keep the full-array contract. The old handler shipped
    // the tenant's ENTIRE leave history on every request.
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [list, total] = paged
      ? await Promise.all([
          db.leaveRequest.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
          db.leaveRequest.count({ where }),
        ])
      : [await db.leaveRequest.findMany({ where, orderBy: { createdAt: "desc" } }), null]
    const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId } })
    // M-11 — reference select: never haul base64 photo columns for a name
    // join. MOD-16 — names resolve from the PAGE's ids via one whereIn (was:
    // the whole tenant directory per request, with .find() per row)
    const pageEmpIds = [...new Set(list.flatMap((l) => [l.employeeId, l.substituteEmployeeId].filter((x): x is string => !!x)))]
    const employees = pageEmpIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: pageEmpIds } }, select: EMPLOYEE_REF_SELECT })
      : []
    const typeById = new Map(types.map((t) => [t.id, t]))
    const empById = new Map(employees.map((e) => [e.id, e]))
    const items = list.map((l) => {
      // R3 — attachment BYTES never ride with the list; only the file name
      // (bytes come from the audited leaveRequests.attachment route).
      const { attachmentData: _attachmentData, ...rest } = l as any
      return {
        ...rest,
        typeName: typeById.get(l.leaveTypeId)?.name || "—",
        paid: typeById.get(l.leaveTypeId)?.paid,
        employeeName: empById.get(l.employeeId)?.fullName || "—",
        employeeCode: empById.get(l.employeeId)?.code,
        substituteName: l.substituteEmployeeId ? empById.get(l.substituteEmployeeId)?.fullName : undefined,
        attachment: l.attachmentName ? { name: l.attachmentName } : null,
      }
    })
    return paged ? { items, total, page, pageSize } : items
  },
})

async function checkSubstitute(vendorId: string, employeeId: string, substituteId: string, from: string, to: string) {
  const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId } })
  const sub = await db.employee.findFirst({ where: { id: substituteId, vendorId, status: { in: ["ACTIVE", "PROBATION"] } } })
  if (!emp || !sub) return { ok: false, reason: "Employee or substitute not found", notes: "" }

  /** 2026-10-13 — canonical weekly-off for an employee (employee > shift >
   *  global policy). Local helper so every leave-path decision (substitute
   *  eligibility, day counting, LEAVE-row writing) uses the SAME precedence
   *  the payroll engine uses. */
  const weeklyOffFor = async (e: { weeklyOff?: string | null; shiftId?: string | null }): Promise<string[]> => {
    const shift = e.shiftId ? await db.shift.findFirst({ where: { id: e.shiftId, vendorId }, select: { weeklyOff: true } }) : null
    const settings = await getSettings(vendorId)
    return resolveWeeklyOffDays(e.weeklyOff, shift?.weeklyOff, settings.general.weeklyHoliday)
  }

  // R4 — eligibility is now split into HARD blockers (the substitute genuinely
  // cannot cover: on leave / scheduled off during the period) and SOFT notes
  // (different branch / department / grade) that no longer disqualify a
  // colleague. Small departments often have no same-department peer, so
  // cross-department substitutes are now eligible — the notes are surfaced in
  // the picker for transparency instead of blocking the request.
  const blockers: string[] = []
  const notes: string[] = []
  if (emp.branchId && sub.branchId && emp.branchId !== sub.branchId) notes.push("different branch")
  if (emp.departmentId && sub.departmentId && emp.departmentId !== sub.departmentId) notes.push("different department")
  // comparable seniority: a substitute a full grade below the requester is a
  // soft note (HR/approver can still reject) — not a hard blocker
  if (emp.grade && sub.grade) {
    const gRank = (g: unknown) => { const m = String(g ?? "").match(/(\d+)/); return m ? Number(m[1]) : null }
    const eg = gRank(emp.grade), sg = gRank(sub.grade)
    if (eg != null && sg != null && sg > eg + 1) notes.push("substitute is a lower grade")
  }
  const onLeave = await db.leaveRequest.findFirst({
    where: { vendorId, employeeId: substituteId, status: "APPROVED", fromDate: { lte: to }, toDate: { gte: from } },
  })
  if (onLeave) blockers.push("substitute already on leave in this period")
  // roster: substitute must not be scheduled off during the period
  const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  const dowOf = (ds: string) => wd[new Date(`${ds}T00:00:00Z`).getUTCDay()]
  // 2026-10-13 — resolveWeeklyOffDays (employee > shift > global policy)
  const offs = await weeklyOffFor(sub)
  let d = from, guard = 0
  while (d <= to && guard < 200) {
    if (offs.includes(dowOf(d))) { blockers.push("substitute is scheduled off within the period"); break }
    d = addDays(d, 1)
    guard++
  }
  return { ok: blockers.length === 0, reason: blockers.join("; ") || "eligible", notes: notes.join("; "), sub }
}

  // INTENTIONALLY_SELF_SCOPED (M-02): self/HR apply: handler checks ess.create or leave.create + employee scope (H-04)
route("leaveRequests.apply", {
  schema: S.leaveApply,
  // Employees apply via ESS (ess.create); HR admins apply from the Leave view
  // (leave.create). Both paths route through the same audited handler.
  handler: async (ctx, p) => {
    if (!ctx.permissions.has("ess.create") && !ctx.permissions.has("leave.create")) {
      throw new Deny("Permission denied: leave application is not granted to your role")
    }
    // ESS employees apply for themselves; HR can apply on behalf (leave.create)
    const employeeId = ctx.role === "EMPLOYEE" ? ctx.employeeId : p.employeeId || ctx.employeeId
    if (!employeeId) throw new Deny("No employee profile linked", 400)
    if (ctx.role === "EMPLOYEE" && p.employeeId && p.employeeId !== ctx.employeeId) {
      throw new Deny("You can only apply for your own leave")
    }
    // SUB-107 (Wave R3-5) — the EMPLOYEE self-application path rides the ESS
    // plan feature: a plan with essEnabled=false (or an owner override) must
    // not let employees self-file leave while HR (leave.create) keeps working
    // — leave itself is core for HR. Placed AFTER the identity checks so the
    // 403 carries the upgrade message only to the ESS plane.
    if (ctx.role === "EMPLOYEE") {
      await requireFeature(ctx.vendorId, "ESS")
    }
    // H-04/H-05 — a client-supplied employeeId must resolve INSIDE the caller's
    // scope (BRANCH_MANAGER/DEPT_MANAGER cannot file leave across branches).
    if (ctx.role !== "EMPLOYEE" && p.employeeId && p.employeeId !== ctx.employeeId) {
      await assertEmployeeVisible(ctx, p.employeeId)
    }
    const settings = await getSettings(ctx.vendorId)
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    if (!["ACTIVE", "PROBATION", "ON_LEAVE"].includes(emp.status)) throw new Deny(`Cannot apply while status is ${emp.status}`)

    const type = await db.leaveType.findFirst({ where: { id: p.leaveTypeId, vendorId: ctx.vendorId } })
    if (!type) throw new Deny("Leave type not found", 404)
    if (emp.status === "PROBATION" && !type.probationEligible) {
      throw new Deny(`${type.name} leave is not available during probation`)
    }
    // LVE-107 — gender-restricted eligibility (maternity → FEMALE, paternity
    // → MALE). Any employee could previously apply for either; the statutory
    // types now gate on the employee's recorded gender.
    if (type.genderRestriction && type.genderRestriction !== emp.gender) {
      throw new Deny(`${type.name} is only available to ${type.genderRestriction === "FEMALE" ? "female" : "male"} employees`)
    }
    // LVE-003 (R3-4) — enforce the two policy knobs that were configured,
    // seeded and displayed but never applied:
    //   1. waitingPeriodDays — service length before this type is takeable
    //      (CASUAL seeds 0, others 30);
    //   2. probationMaxDays — Settings → Leave per-request cap while the
    //      employee is on probation (enforced below against the computed
    //      working-day count, right after the count exists).
    if (emp.joiningDate) {
      const wait = Math.max(0, Number((type as any).waitingPeriodDays) || 0)
      if (wait > 0 && daysBetween(emp.joiningDate, p.fromDate) < wait) {
        throw new Deny(`${type.name} requires ${wait} day(s) of service before it can be taken (joined ${emp.joiningDate})`)
      }
    }
    // R3 — Types & Policies "requires attachment" rule: the supporting document
    // must ride with the application itself (attachmentData, base64).
    if ((type as any).requiresAttachment && !p.attachmentData) {
      throw new Deny(`${type.name} applications require a supporting document — attach a file (PDF/image, max 2 MB)`)
    }
    // L-29 — byte-level validation of the supporting document (the client
    // dialog said "PDF/image, max 2 MB" but the server previously stored ANY
    // base64 payload; the served MIME is now sniffed from bytes as well).
    if (p.attachmentData) {
      const check = validateLeaveAttachment(p.attachmentData)
      if (!check.ok) throw new Deny(check.reason, 400)
      // SaaS storage quota — count the incoming attachment bytes against the
      // plan (LEGACY tenants have no quota configured and pass untouched).
      await requireCapacity(ctx.vendorId, "STORAGE", 0, { extraUsed: String(p.attachmentData).length })
    }
    if (!settings.leave.allowBackdated && p.fromDate < today()) throw new Deny("Backdated leave not allowed")
    if (settings.leave.allowBackdated && p.fromDate < addDays(today(), -settings.leave.maxBackdateDays)) {
      throw new Deny(`Backdated leave allowed only ${settings.leave.maxBackdateDays} days back`)
    }
    if (!p.fromDate || !p.toDate || p.fromDate > p.toDate) throw new Deny("Invalid leave dates")

    // 2026-10-13 — canonical precedence (employee > shift > global policy)
    const empShift = emp.shiftId ? await db.shift.findFirst({ where: { id: emp.shiftId, vendorId: ctx.vendorId }, select: { weeklyOff: true } }) : null
    const weeklyOff = resolveWeeklyOffDays(emp.weeklyOff, empShift?.weeklyOff, settings.general.weeklyHoliday)
    // L-9 — holiday-aware day counting: vendors can opt out of counting
    // PUBLIC/COMPANY holidays inside a leave span as balance consumption (the
    // holiday is already a non-working day). Default true = historical
    // behavior. OPTIONAL holidays are never skipped (employee-elected).
    let holidaysInSpan: string[] = []
    if (!settings.leave.countHolidaysAsLeave) {
      const rows = await db.holiday.findMany({
        where: {
          vendorId: ctx.vendorId, type: { in: ["PUBLIC", "COMPANY"] },
          date: { gte: p.fromDate, lte: p.toDate },
          OR: [{ branchId: null }, ...(emp.branchId ? [{ branchId: emp.branchId }] : [])],
        },
        select: { date: true },
      })
      holidaysInSpan = rows.map((r) => r.date)
    }
    // H-6 — the server ALWAYS computes the authoritative day count. The client
    // `days` field is ignored entirely (an attacker-supplied count can never
    // bypass the balance check or distort the attendance rows written later).
    // Audit Low — half-day requests consume half a day of balance.
    let days = leaveDaysBetween(p.fromDate, p.toDate, weeklyOff, holidaysInSpan)
    // LVE-101 — the zero-working-day check must run BEFORE the half-day floor:
    // a weekend/holiday-only "half-day" used to pass as 0.5 days, burned
    // balance and wrote a LEAVE row on a day the employee never works.
    if (days <= 0) throw new Deny("Requested period has zero working days")
    if (p.halfDay) days = Math.max(0.5, days - 0.5)
    // LVE-003 — per-request day cap for probationers applies to the computed
    // working-day count (kept next to the count it caps; see the note above
    // for the other half of the policy enforcement).
    {
      const cap = Math.max(0, Number(settings.leave.probationMaxDays) || 0)
      if (emp.status === "PROBATION" && cap > 0 && days > cap) {
        throw new Deny(`Probation employees may take at most ${cap} day(s) per request (Settings → Leave) — split the request or complete probation first`)
      }
    }
    // LVE-113 (R7) — consecutive-day caps (BD labour norms: casual leave is
    // taken in short runs, not month-long stretches). The cap counts
    // CALENDAR-day runs of the same type, stitching the requested window
    // together with adjacent PENDING/APPROVED requests of the same type —
    // 3 days now + 2 days approved starting tomorrow is a 5-day run.
    {
      const cap = Math.max(0, Number((type as any).maxConsecutiveDays) || 0)
      if (cap > 0) {
        const margin = cap + 2
        const neighbors = await db.leaveRequest.findMany({
          where: {
            vendorId: ctx.vendorId, employeeId, leaveTypeId: type.id,
            status: { in: ["PENDING", "APPROVED"] as any },
            fromDate: { gte: addDays(p.fromDate, -margin) }, toDate: { lte: addDays(p.toDate, margin) },
          },
          select: { fromDate: true, toDate: true },
        })
        const spans: Array<[string, string]> = [
          ...neighbors.map((n) => [n.fromDate, n.toDate] as [string, string]),
          [p.fromDate, p.toDate] as [string, string],
        ]
        spans.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        let run = 0, longest = 0, curEnd: string | null = null
        for (const [f, t] of spans) {
          if (curEnd !== null && addDays(curEnd, 1) >= f) {
            if (t > curEnd) { run += daysBetween(curEnd, t); curEnd = t }
          } else {
            run = daysBetween(f, t) + 1
            curEnd = t
          }
          if (run > longest) longest = run
        }
        if (longest > cap) {
          throw new Deny(`${type.name} is capped at ${cap} consecutive day(s) per run (the requested dates form a ${longest}-day run together with adjacent requests)`)
        }
      }
    }

    // M-2 / LVE-004 (R3-4) — overlapping-request guard. The old check matched
    // PENDING only: once request A was APPROVED, a second overlapping request
    // B passed validation — both consumed balance and both wrote LEAVE rows
    // for the same dates (double-charged days, contradictory approvals).
    // APPROVED requests now block too; a PENDING request keeps blocking as
    // before. (LVE-103: this pre-check stays for the fast UX failure — the
    // authoritative re-check runs INSIDE the transaction below, serialized by
    // the balance-row FOR UPDATE lock, so two concurrent applications for the
    // same employee can never both pass.)
    const overlapWhere = {
      vendorId: ctx.vendorId, employeeId, status: { in: ["PENDING", "APPROVED"] as any },
      fromDate: { lte: p.toDate }, toDate: { gte: p.fromDate },
    }
    const overlap = await db.leaveRequest.findFirst({ where: overlapWhere })
    if (overlap) {
      throw new Deny(overlap.status === "PENDING"
        ? "You already have a pending leave request overlapping these dates — wait for its decision or cancel it first"
        : `An approved leave (${overlap.fromDate} → ${overlap.toDate}) already covers these dates — overlapping requests are not allowed`)
    }

    // balance row — created lazily; the REMAINING CHECK runs inside the
    // transaction below (H-9), serialized against concurrent applications by
    // SELECT ... FOR UPDATE on the balance row.
    // LVE-104 — the leave year is keyed by its START year (fiscal-year start
    // month, July default): a January request charges the ledger the July
    // rollover actually carries from. The old calendar-year keying made the
    // rollover read an 18-month-old ledger while the current year charged a
    // row nobody carried into.
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    const fyStartMonth = Math.max(0, months.indexOf(settings.general.fiscalYearStart || "July"))
    const year = leaveYearOf(p.fromDate, fyStartMonth)
    let bal = await db.leaveBalance.findFirst({ where: { employeeId, leaveTypeId: type.id, year } })
    if (!bal) {
      try {
        // LVE-106 — PRO_RATA types open at the joining-date-prorated quota,
        // never the full annual quota on day one.
        const openingEntitled = (type.accrualFrequency === "PRO_RATA" && emp.joiningDate)
          ? proRatedEntitlement(type.defaultDays, emp.joiningDate, year, fyStartMonth, p.fromDate)
          : type.defaultDays
        bal = await db.leaveBalance.create({ data: { vendorId: ctx.vendorId, employeeId, leaveTypeId: type.id, year, entitled: openingEntitled } })
      } catch (e: any) {
        // H-9 — two concurrent first-applications both auto-create the row:
        // the loser of the unique-key race re-fetches the winner's row.
        if (String(e?.code) !== "P2002") throw e
        bal = await db.leaveBalance.findFirst({ where: { employeeId, leaveTypeId: type.id, year } })
      }
    }
    if (!bal) throw new Deny("Could not initialize the leave balance for this year", 500)

    // A8 — optional-holiday limit: cap how many OPTIONAL holidays an employee
    // can take as leave per year (Settings → Leave → optionalHolidayLimit).
    const optionalLimit = Number(settings.leave.optionalHolidayLimit ?? 0)
    if (optionalLimit > 0) {
      const yearHolidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, type: "OPTIONAL", date: { gte: `${year}-01-01`, lte: `${year}-12-31` } } })
      const optDates = new Set(yearHolidays.map((h) => h.date))
      const overlapDays = (from: string, to: string) => {
        let n = 0, d = from, guard = 0
        while (d <= to && guard < 400) { if (optDates.has(d)) n++; d = addDays(d, 1); guard++ }
        return n
      }
      const thisOptional = overlapDays(p.fromDate, p.toDate)
      if (thisOptional > 0) {
        const prior = await db.leaveRequest.findMany({
          where: { vendorId: ctx.vendorId, employeeId, status: "APPROVED",
            OR: [{ fromDate: { gte: `${year}-01-01` } }, { toDate: { gte: `${year}-01-01` } }] },
        })
        let usedOptional = 0
        for (const r of prior) usedOptional += overlapDays(r.fromDate, r.toDate)
        if (usedOptional + thisOptional > optionalLimit) {
          throw new Deny(`Optional-holiday limit reached: ${usedOptional} of ${optionalLimit} already used this year; this request adds ${thisOptional}`)
        }
      }
    }

    // R4 — substitute validation (spec §8.3, relaxed). A named substitute is
    // still fully validated (HARD blockers reject). But an employee with NO
    // available colleague (e.g. no same-department peer) may now submit
    // WITHOUT a substitute: the request skips the substitute-acceptance step
    // entirely and enters the approval workflow at the FIRST approver
    // (manager / HR) — it is never stranded. The old behavior hard-denied
    // when Settings → Leave → "substitute required" was ON.
    let subStatus: string | null = null
    let subNotes: string | null = null
    if (p.substituteEmployeeId) {
      const check = await checkSubstitute(ctx.vendorId, employeeId, p.substituteEmployeeId, p.fromDate, p.toDate)
      if (!check.ok) throw new Deny(`Substitute not eligible: ${check.reason}`)
      subStatus = settings.leave.substituteAcceptanceRequired ? "PENDING" : "ACCEPTED"
      subNotes = check.notes || null
    }

    // H-14 — ALL state writes atomic: request row + pending-balance increment +
    // approval request + approvalRequestId back-link run in ONE transaction.
    // A failure in ANY step (e.g. the approval engine throwing) rolls back the
    // whole application: balance unchanged, no orphaned request row.
    const { createApprovalRequest, announceApprovalRequest } = await import("../approval")
    let approvalId: string | null = null
    let restSeq = 0
    const req = await db.$transaction(async (tx) => {
      // H-9 — the remaining-balance check runs INSIDE the transaction, on a
      // row locked FOR UPDATE. The old pre-tx snapshot let two concurrent
      // applications both pass the check and both increment pending
      // (over-reserved balance with no DB constraint to catch it). The row
      // lock serializes them: the second caller re-reads the committed state
      // and fails the check cleanly.
      await tx.$queryRaw`SELECT "id" FROM "LeaveBalance" WHERE "id" = ${bal.id} FOR UPDATE`
      const locked = await tx.leaveBalance.findUnique({ where: { id: bal.id } })
      // LVE-103 — the authoritative overlap re-check, INSIDE the transaction
      // and after the balance-row lock: a concurrent application for the same
      // employee blocks on this same LeaveBalance row, commits, and THIS
      // re-check then sees the committed request and fails cleanly (the old
      // outside-tx-only check let both pass and double-charged the days).
      const racingOverlap = await tx.leaveRequest.findFirst({ where: overlapWhere })
      if (racingOverlap) {
        throw new Deny(racingOverlap.status === "PENDING"
          ? "You already have a pending leave request overlapping these dates — wait for its decision or cancel it first"
          : `An approved leave (${racingOverlap.fromDate} → ${racingOverlap.toDate}) already covers these dates — overlapping requests are not allowed`)
      }
      // LVE-002 (R3-4) — canonical spendable formula (carried-forward days
      // are spendable at apply time); LVE-105 — with the type's carry-expiry
      // window, carried days past their expiry stop counting
      const remaining = spendableDays(locked, {
        asOf: p.fromDate,
        fyStartMonth,
        carryForwardExpiryMonths: type.carryForwardExpiryMonths,
      })
      if (type.paid && days > remaining) {
        throw new Deny(`Insufficient balance: ${remaining} day(s) remaining of ${type.name}`)
      }
      const created = await tx.leaveRequest.create({
        data: {
          vendorId: ctx.vendorId, employeeId, leaveTypeId: type.id,
          fromDate: p.fromDate, toDate: p.toDate, days,
          reason: p.reason || null, halfDay: !!p.halfDay,
          contactNumber: p.contactNumber ? String(p.contactNumber).trim().slice(0, 30) || null : null,
          attachmentName: p.attachmentName || null, attachmentData: p.attachmentData ? encryptAttachment(p.attachmentData) : null,
          substituteEmployeeId: p.substituteEmployeeId || null, substituteStatus: subStatus,
          status: "PENDING",
        },
      })
      // MOD-5 (Phase 2 WS6) — inline attachment bytes bump (best-effort;
      // the nightly storage reconciliation is the correctness backstop)
      if (p.attachmentData) await bumpStorageRollup(ctx.vendorId, String(p.attachmentData).length)
      await tx.leaveBalance.update({ where: { id: bal.id }, data: { pending: { increment: days } } }) // M-2 — atomic increment
      // submit through approval engine unless waiting for substitute acceptance
      if (subStatus !== "PENDING") {
        const sub = await createApprovalRequest(ctx, "LEAVE", "LeaveRequest", created.id,
          `${emp.fullName} — ${type.name} (${days}d)`, { employeeId, amount: days, leaveTypeId: type.id }, tx)
        approvalId = sub.id
        restSeq = sub.restSeq
        await tx.leaveRequest.update({ where: { id: created.id }, data: { approvalRequestId: sub.id } })
      }
      return { ...created, ...(approvalId ? { approvalRequestId: approvalId } : {}) }
    })
    // post-commit side effects — NEVER inside the transaction (H-14)
    if (approvalId) {
      await announceApprovalRequest(ctx, "LEAVE", "LeaveRequest", req.id, approvalId, restSeq,
        `${emp.fullName} — ${type.name} (${days}d)`, { employeeId, amount: days, leaveTypeId: type.id })
    }
    await audit(ctx, "leaveRequests.apply", "LeaveRequest", req.id,
      `${emp.fullName} applied ${type.name} ${p.fromDate}→${p.toDate} (${days}d)${p.substituteEmployeeId ? (subNotes ? ` — substitute: ${subNotes}` : " — with substitute") : " — WITHOUT substitute (skipped substitute acceptance; sent directly for approval)"}`)
    // Wave 4 WP-C — outbound webhook (fire-and-forget, delivery-log-backed)
    void webhookEmit(ctx.vendorId, "leave.requested", {
      id: req.id, employeeId, employeeName: emp.fullName, typeName: type.name,
      fromDate: p.fromDate, toDate: p.toDate, days, status: "PENDING",
    })
    await notifyChannels(ctx.vendorId, { employeeId }, "Leave Request Submitted",
      `Your ${type.name} leave request (${days} day(s)) is submitted for approval.`, "LEAVE", "ess",
      { email: true }, "leave_request",
      { employee: emp.fullName, leaveType: type.name, fromDate: p.fromDate, toDate: p.toDate, days })
    if (p.substituteEmployeeId) {
      await notify(ctx.vendorId, { employeeId: p.substituteEmployeeId }, "Substitute Assignment",
        `You are proposed as substitute for ${emp.fullName}'s leave (${p.fromDate} → ${p.toDate}). Please accept/decline.`, "LEAVE", "ess")
    }
    // notify reporting manager
    if (emp.reportingManagerId) {
      await notify(ctx.vendorId, { employeeId: emp.reportingManagerId }, "Leave Request",
        `${emp.fullName} requested ${days} day(s) of ${type.name}.`, "LEAVE", "approvals")
    }
    return req
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): only the assigned substitute (matched by ctx.employeeId) can respond
route("leaveRequests.substitute.respond", {
  handler: async (ctx, p) => {
    const req = await db.leaveRequest.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, substituteStatus: "PENDING" } })
    if (!req) throw new Deny("No pending substitute request", 404)
    if (ctx.role === "EMPLOYEE" && ctx.employeeId !== req.substituteEmployeeId) {
      throw new Deny("Only the assigned substitute can respond")
    }
    if (!["HR_ADMIN", "HR_MANAGER"].includes(ctx.role) && ctx.employeeId !== req.substituteEmployeeId) {
      throw new Deny("Only the assigned substitute can respond")
    }
    const accepted = p.decision === "ACCEPTED"
    await db.leaveRequest.update({
      where: { id: req.id },
      data: { substituteStatus: p.decision, substituteComment: p.comment || null },
    })
    if (accepted && req.status === "PENDING" && !req.approvalRequestId) {
      const emp = await db.employee.findUnique({ where: { id: req.employeeId } })
      const { submitForApproval } = await import("../approval")
      const approvalId = await submitForApproval(ctx, "LEAVE", "LeaveRequest", req.id,
        `${emp?.fullName} — leave (${req.days}d)`, { employeeId: req.employeeId, amount: req.days, leaveTypeId: req.leaveTypeId })
      await db.leaveRequest.update({ where: { id: req.id }, data: { approvalRequestId: approvalId } })
    }
    await audit(ctx, "leaveRequests.substitute.respond", "LeaveRequest", req.id, `Substitute ${p.decision}`)
    await notify(ctx.vendorId, { employeeId: req.employeeId }, "Substitute " + (accepted ? "Accepted" : "Declined"),
      `Your substitute ${accepted ? "accepted" : "declined"} the assignment.`, "LEAVE", "ess")
    return { status: p.decision }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): only the request owner (matched by ctx.employeeId) can change the substitute
route("leaveRequests.substitute.change", {
  // After a DECLINED substitute the requester (or HR) may pick a new one —
  // the request is never stranded (spec §8.3 substitute workflow).
  handler: async (ctx, p) => {
    const req = await db.leaveRequest.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, status: "PENDING", substituteStatus: "DECLINED" } })
    if (!req) throw new Deny("No declined-substitute pending request found", 404)
    const own = ctx.employeeId === req.employeeId
    if (!own && !ctx.permissions.has("leave.edit") && !ctx.permissions.has("leave.approve")) {
      throw new Deny("Only the requester or HR can change the substitute")
    }
    if (!p.substituteEmployeeId) throw new Deny("New substitute employee is required")
    const check = await checkSubstitute(ctx.vendorId, req.employeeId, p.substituteEmployeeId, req.fromDate, req.toDate)
    if (!check.ok) throw new Deny(`Substitute not eligible: ${check.reason}`)
    const settings = await getSettings(ctx.vendorId)
    await db.leaveRequest.update({
      where: { id: req.id },
      data: { substituteEmployeeId: p.substituteEmployeeId, substituteStatus: settings.leave.substituteAcceptanceRequired ? "PENDING" : "ACCEPTED", substituteComment: null },
    })
    if (!settings.leave.substituteAcceptanceRequired && !req.approvalRequestId) {
      const emp = await db.employee.findUnique({ where: { id: req.employeeId } })
      const { submitForApproval } = await import("../approval")
      const approvalId = await submitForApproval(ctx, "LEAVE", "LeaveRequest", req.id,
        `${emp?.fullName} — leave (${req.days}d)`, { employeeId: req.employeeId, amount: req.days, leaveTypeId: req.leaveTypeId })
      await db.leaveRequest.update({ where: { id: req.id }, data: { approvalRequestId: approvalId } })
    }
    await audit(ctx, "leaveRequests.substitute.change", "LeaveRequest", req.id, `Substitute changed after decline`)
    await notify(ctx.vendorId, { employeeId: p.substituteEmployeeId }, "Substitute Assignment",
      `You are proposed as substitute for a leave (${req.fromDate} → ${req.toDate}). Please accept/decline.`, "LEAVE", "ess")
    return { changed: true }
  },
})

// ---------- R3: leave attachment download (supporting document of the application) ----------
// INTENTIONALLY_SELF_SCOPED (M-02): the handler enforces caller-identity
// scoping — only the request owner, the assigned substitute, or a
// leave.view / leave.approve / leave.edit permission holder may fetch bytes.
route("leaveRequests.attachment", {
  handler: async (ctx, p) => {
    const req = await db.leaveRequest.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!req || !req.attachmentData) throw new Deny("Attachment not found", 404)
    const own = ctx.employeeId === req.employeeId
    const isSubstitute = !!ctx.employeeId && ctx.employeeId === req.substituteEmployeeId
    const canViewAll = ctx.permissions.has("leave.view") || ctx.permissions.has("leave.approve") || ctx.permissions.has("leave.edit")
    if (!own && !isSubstitute && !canViewAll) throw new Deny("Not authorized to view this attachment")
    const emp = await db.employee.findUnique({ where: { id: req.employeeId } })
    // L-29 — MIME from the STORED BYTES (magic-number sniff), never from the
    // client-controlled attachmentName; unrecognized payloads are served as
    // application/octet-stream (download, no inline preview).
    const sniffed = sniffMime(decodeBase64Payload(String(req.attachmentData)) || Buffer.alloc(0))
    // R1-027 — decrypt the stored (encrypted) attachment before returning
    const plainData = decryptAttachment(req.attachmentData)
    const sniffedDecrypted = sniffMime(decodeBase64Payload(plainData) || Buffer.alloc(0))
    await audit(ctx, "leaveRequests.attachment", "LeaveRequest", req.id, `Downloaded attachment of ${emp?.fullName}'s leave request (${req.attachmentName || "file"})`)
    return {
      fileName: req.attachmentName,
      fileData: plainData,
      mimeType: sniffedDecrypted || sniffed || "application/octet-stream",
    }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): only the request owner or an HR permission holder can cancel (handler checks)
route("leaveRequests.cancel", {
  handler: async (ctx, p) => {
    const req = await db.leaveRequest.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!req) throw new Deny("Not found", 404)
    const own = ctx.employeeId === req.employeeId
    if (!own && !ctx.permissions.has("leave.approve") && !ctx.permissions.has("leave.edit")) {
      throw new Deny("Not authorized to cancel this request")
    }
    if (!["PENDING", "APPROVED"].includes(req.status)) throw new Deny(`Cannot cancel a ${req.status.toLowerCase()} request`)
    // LVE-009 (R3-4) — cancel is a CONDITIONAL CLAIM, mirroring the approval
    // engine's own discipline: the status write only lands when the row is
    // still PENDING/APPROVED, so an approver finalizing at the same instant can
    // never interleave with this write (the old unconditional update could
    // leave a CANCELLED request with used incremented and LEAVE rows written,
    // or an APPROVED request with a stomped-CANCELLED approval).
    const claimed = await db.leaveRequest.updateMany({
      where: { id: req.id, status: { in: ["PENDING", "APPROVED"] } },
      data: { status: "CANCELLED", actedBy: ctx.userId, actedAt: new Date() },
    })
    if (claimed.count === 0) throw new Deny(`This request was just ${req.status === "PENDING" ? "decided" : "changed"} by someone else — refresh and retry`, 409)
    // restore balance (LVE-104 — the same leave-year keying the apply path
    // used, so the decrement always lands on the row that was incremented)
    const cancelSettings = await getSettings(ctx.vendorId)
    const cancelMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    const cancelFy = Math.max(0, cancelMonths.indexOf(cancelSettings.general.fiscalYearStart || "July"))
    const year = leaveYearOf(req.fromDate, cancelFy)
    const bal = await db.leaveBalance.findFirst({ where: { employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, year } })
    if (bal) {
      const wasUsed = req.status === "APPROVED"
      // H-9 — guarded atomic decrements (the old read-then-write absolute
      // updates lost updates under concurrency and could go negative on
      // corrupted history; the clamp keeps the ledger non-negative).
      if (wasUsed) {
        const back = await db.leaveBalance.updateMany({
          where: { id: bal.id, used: { gte: req.days } },
          data: { used: { decrement: req.days } },
        })
        if (back.count !== 1) {
          await db.leaveBalance.update({ where: { id: bal.id }, data: { used: 0 } })
        }
      } else {
        const back = await db.leaveBalance.updateMany({
          where: { id: bal.id, pending: { gte: req.days } },
          data: { pending: { decrement: req.days } },
        })
        if (back.count !== 1) {
          await db.leaveBalance.update({ where: { id: bal.id }, data: { pending: 0 } })
        }
      }
      if (wasUsed) {
        // LVE-009 (R3-4) — the old retro-cancel blanket-flipped every LEAVE row
        // of the span to ABSENT, destroying any underlying punch state for days
        // the employee actually worked. Rows this approval auto-wrote (source
        // MANUAL, "(approved" remarks marker, or a synthetic HALF_DAY) are now
        // RESTORED from their punches where punches exist, and removed where
        // they were purely synthetic — the daily ABSENT sweep re-materializes
        // genuinely unworked days, and human-marked rows are never touched.
        // LVE-102 — UNPAID (LWP) approvals write LEAVE_UNPAID rows; the old
        // filter matched LEAVE/HALF_DAY only, so cancelling an approved
        // unpaid request restored the balance but left the LEAVE_UNPAID rows
        // behind — payroll kept treating the days as unpaid absence.
        const spanRows = await db.attendance.findMany({
          where: { vendorId: ctx.vendorId, employeeId: req.employeeId, date: { gte: req.fromDate, lte: req.toDate }, status: { in: ["LEAVE", "HALF_DAY", "LEAVE_UNPAID"] } },
        })
        for (const row of spanRows) {
          const synthetic = row.source === "MANUAL" && !!row.remarks && /\(approved/.test(row.remarks)
          if (!synthetic) continue // a human wrote this row (or another leave) — leave it alone
          if (row.checkIn) {
            // punches exist: recompute the day from them (status, minutes, OT)
            const { computeAttendance } = await import("./attendance")
            const settings = await getSettings(ctx.vendorId)
            const shift = row.shiftId ? await db.shift.findFirst({ where: { id: row.shiftId, vendorId: ctx.vendorId } }) : null
            const calc = computeAttendance(shift, row.checkIn, row.checkOut, settings.attendance.halfDayHours,
              { graceMinutes: settings.latePolicy?.graceMinutes, earlyLeaveThresholdMinutes: settings.earlyLeavePolicy?.thresholdMinutes,
                maxOtMinutesPerDay: (Number((settings as any).shift?.maxOtHoursPerDay) || 0) * 60 })
            await db.attendance.update({
              where: { id: row.id },
              data: {
                status: calc.status, workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
                earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes,
                remarks: `Leave cancelled — recomputed from punches (was: ${row.remarks || "leave"})`,
              },
            })
          } else {
            // purely synthetic row from the approval — remove it; the ABSENT
            // sweep re-materializes genuinely unworked days
            await db.attendance.delete({ where: { id: row.id } })
          }
        }
      }
    }
    if (req.approvalRequestId) {
      // LVE-009 — only a still-PENDING approval request is cancelled; a
      // finalized one keeps its historical decision (the conditional claim
      // above already refused to cancel a decided leave).
      await db.approvalRequest.updateMany({ where: { id: req.approvalRequestId, status: "PENDING" }, data: { status: "CANCELLED" } })
    }
    await audit(ctx, "leaveRequests.cancel", "LeaveRequest", req.id, "Cancelled leave request")
    return { cancelled: true }
  },
})

// ---------- LEAVE finalize hook (called by approval engine only) ----------
export async function applyLeaveDecision(ctx: { userId: string; userName: string; vendorId: string }, reqId: string, decision: string) {
  const req = await db.leaveRequest.findFirst({ where: { id: reqId, vendorId: ctx.vendorId } })
  if (!req || req.status !== "PENDING") return
  const type = await db.leaveType.findUnique({ where: { id: req.leaveTypeId } })
  const emp = await db.employee.findUnique({ where: { id: req.employeeId } })
  // LVE-104 — the same leave-year keying the apply path used
  const finSettings = await getSettings(ctx.vendorId)
  const finMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const finFy = Math.max(0, finMonths.indexOf(finSettings.general.fiscalYearStart || "July"))
  const year = leaveYearOf(req.fromDate, finFy)
  const bal = await db.leaveBalance.findFirst({ where: { employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, year } })

  if (decision === "APPROVED") {
    // R1-011: wrap status + balance writes in a single transaction to prevent
    // partial commits (e.g. status=APPROVED but balance not decremented).
    await db.$transaction(async (tx) => {
      await tx.leaveRequest.update({ where: { id: req.id }, data: { status: "APPROVED", actedBy: ctx.userId, actedAt: new Date() } })
      if (bal) {
        // H-9 — guarded ATOMIC decrement (the old code wrote `pending` as an
        // absolute value from a stale read while `used` incremented atomically:
        // two concurrent approvals of different requests lost one decrement,
        // leaving pending stuck above zero). The where-guard keeps pending
        // non-negative; a short/corrupted reservation clamps to 0 instead.
        const claimed = await tx.leaveBalance.updateMany({
          where: { id: bal.id, pending: { gte: req.days } },
          data: { pending: { decrement: req.days }, used: { increment: req.days } },
        })
        if (claimed.count !== 1) {
          await tx.leaveBalance.update({ where: { id: bal.id }, data: { pending: 0, used: { increment: req.days } } })
        }
      }
    })
    // write attendance LEAVE rows for consumed days (payroll consumes attendance)
    // Audit Low — a half-day request writes a HALF_DAY row for its first day
    const settings = await getSettings(ctx.vendorId)
    // 2026-10-13 — canonical precedence (employee > shift > global policy)
    const empShift = emp?.shiftId ? await db.shift.findFirst({ where: { id: emp.shiftId, vendorId: ctx.vendorId }, select: { weeklyOff: true } }) : null
    const weeklyOff = resolveWeeklyOffDays(emp?.weeklyOff, empShift?.weeklyOff, settings.general.weeklyHoliday)
    // L-9 — the SAME holiday skip the application used for the day count, so
    // the number of LEAVE-marked days always equals the balance consumed.
    let holidaySkip = new Set<string>()
    if (!settings.leave.countHolidaysAsLeave) {
      const rows = await db.holiday.findMany({
        where: {
          vendorId: ctx.vendorId, type: { in: ["PUBLIC", "COMPANY"] },
          date: { gte: req.fromDate, lte: req.toDate },
          OR: [{ branchId: null }, ...(emp?.branchId ? [{ branchId: emp.branchId }] : [])],
        },
        select: { date: true },
      })
      holidaySkip = new Set(rows.map((r) => r.date))
    }
    const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
    let d = req.fromDate
    let guard = 0
    let halfDayConsumed = !!req.halfDay
    while (d <= req.toDate && guard < 200) {
      const dow = wd[new Date(d + "T00:00:00").getDay()]
      if (!weeklyOff.includes(dow) && !holidaySkip.has(d)) {
        // LVE-001 (R3-4) — the leave type's PAID flag now rides on the
        // attendance row: unpaid (LWP) approvals write LEAVE_UNPAID instead
        // of LEAVE, and calculateRun treats those days as unpaid (absence-
        // prorated), so an unpaid-leave day is no longer paid at full daily
        // rate. Half-day requests keep the historical HALF_DAY row (the
        // half-day is consumed as balance exactly like before).
        const rowStatus = req.halfDay && halfDayConsumed
          ? "HALF_DAY"
          : type?.paid === false ? "LEAVE_UNPAID" : "LEAVE"
        halfDayConsumed = false
        await db.attendance.upsert({
          where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId: req.employeeId, date: d } },
          create: { vendorId: ctx.vendorId, employeeId: req.employeeId, date: d, status: rowStatus, source: "MANUAL", remarks: `${type?.name || "Leave"} (approved${rowStatus === "HALF_DAY" ? " half-day" : rowStatus === "LEAVE_UNPAID" ? " unpaid" : ""})` },
          update: { status: rowStatus, remarks: `${type?.name || "Leave"} (approved${rowStatus === "HALF_DAY" ? " half-day" : rowStatus === "LEAVE_UNPAID" ? " unpaid" : ""})` },
        })
      }
      d = addDays(d, 1)
      guard++
    }
    await db.employeeHistory.create({
      data: { vendorId: ctx.vendorId, employeeId: req.employeeId, eventType: "LEAVE", title: `${type?.name} leave approved (${req.days}d)`, description: `${req.fromDate} → ${req.toDate}`, effectiveDate: req.fromDate, dataJson: JSON.stringify({ leaveRequestId: req.id }) },
    })
    // leave_decision matrix row (Settings → Communication → Automation)
    // controls email/SMS on top of the always-on in-app notification
    await notifyChannels(ctx.vendorId, { employeeId: req.employeeId }, "Leave Approved",
      `Your ${type?.name} leave (${req.fromDate} → ${req.toDate}) is approved.`, "LEAVE", "ess", {}, "leave_decision",
      { leaveType: type?.name || "", fromDate: req.fromDate, toDate: req.toDate, days: req.days, decision: "approved" })
  } else {
    await db.leaveRequest.update({ where: { id: req.id }, data: { status: "REJECTED", actedBy: ctx.userId, actedAt: new Date() } })
    if (bal) {
      // H-9 — guarded atomic decrement (same rationale as the approve path)
      const claimed = await db.leaveBalance.updateMany({
        where: { id: bal.id, pending: { gte: req.days } },
        data: { pending: { decrement: req.days } },
      })
      if (claimed.count !== 1) {
        await db.leaveBalance.update({ where: { id: bal.id }, data: { pending: 0 } })
      }
    }
    await notifyChannels(ctx.vendorId, { employeeId: req.employeeId }, "Leave Rejected",
      `Your ${type?.name} leave request was rejected.`, "LEAVE", "ess", {}, "leave_decision",
      { leaveType: type?.name || "", fromDate: req.fromDate, toDate: req.toDate, days: req.days, decision: "rejected" })
  }
}

// ---------- Substitute eligibility check (for UI) ----------
route("leaveRequests.substituteOptions", {
  perm: ["ess", "view"],
  handler: async (ctx, p) => {
    const emp = await db.employee.findFirst({ where: { id: p.employeeId || ctx.employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    // MOD-4 (Phase 2 WS4) — the picker used to run checkSubstitute PER
    // CANDIDATE (5-6 queries each: employee×2, shift, settings, leaveRequest
    // overlap, weekly-off walk = ~35K queries at 5K staff per date pick).
    // The batched version below computes the IDENTICAL output with a fixed
    // handful of set queries: slim candidate rows, one leaveRequest overlap
    // query over all candidates, one shift lookup for the distinct shift
    // ids, one settings read (cached). checkSubstitute itself stays for the
    // single-candidate apply path.
    const candidates = await db.employee.findMany({
      where: { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION"] }, id: { not: emp.id } },
      select: { id: true, fullName: true, code: true, branchId: true, departmentId: true, grade: true, weeklyOff: true, shiftId: true },
    })
    if (!candidates.length) return []
    const candIds = candidates.map((c) => c.id)
    // approved leave overlapping the requested window, for ALL candidates at once
    const onLeaveRows = await db.leaveRequest.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: candIds }, status: "APPROVED", fromDate: { lte: p.toDate }, toDate: { gte: p.fromDate } },
      select: { employeeId: true },
    })
    const onLeaveSet = new Set(onLeaveRows.map((r) => r.employeeId))
    // weekly-off resolution: distinct shifts of the candidates (employee >
    // shift > global policy, same precedence as checkSubstitute)
    const settings = await getSettings(ctx.vendorId)
    const shiftIds = [...new Set(candidates.map((c) => c.shiftId).filter((x): x is string => !!x))]
    const shiftRows = shiftIds.length
      ? await db.shift.findMany({ where: { vendorId: ctx.vendorId, id: { in: shiftIds } }, select: { id: true, weeklyOff: true } })
      : []
    const shiftOffById = new Map(shiftRows.map((sh) => [sh.id, sh.weeklyOff]))
    const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
    const dowOf = (ds: string) => wd[new Date(`${ds}T00:00:00Z`).getUTCDay()]
    const daysInRange: string[] = []
    {
      let d = String(p.fromDate), guard = 0
      while (d <= String(p.toDate) && guard < 200) { daysInRange.push(dowOf(d)); d = addDays(d, 1); guard++ }
    }
    const out: any[] = []
    for (const c of candidates) {
      // R4 — `eligible` no longer fails on cross-department / cross-branch /
      // grade-gap candidates (those surface as informational `notes`); only
      // genuine blockers (on leave / scheduled off) disqualify.
      const blockers: string[] = []
      const notes: string[] = []
      if (emp.branchId && c.branchId && emp.branchId !== c.branchId) notes.push("different branch")
      if (emp.departmentId && c.departmentId && emp.departmentId !== c.departmentId) notes.push("different department")
      if (emp.grade && c.grade) {
        const gRank = (g: unknown) => { const m = String(g ?? "").match(/(\d+)/); return m ? Number(m[1]) : null }
        const eg = gRank(emp.grade), sg = gRank(c.grade)
        if (eg != null && sg != null && sg > eg + 1) notes.push("substitute is a lower grade")
      }
      if (onLeaveSet.has(c.id)) blockers.push("substitute already on leave in this period")
      const offs = resolveWeeklyOffDays(c.weeklyOff, c.shiftId ? shiftOffById.get(c.shiftId) : null, settings.general.weeklyHoliday)
      if (daysInRange.some((dow) => offs.includes(dow))) blockers.push("substitute is scheduled off within the period")
      out.push({
        id: c.id, fullName: c.fullName, code: c.code,
        eligible: blockers.length === 0, reason: blockers.join("; ") || "eligible", notes: notes.join("; ") || null,
        sameBranch: emp.branchId === c.branchId, sameDepartment: emp.departmentId === c.departmentId,
      })
    }
    return out.filter((c) => (p?.eligibleOnly ? c.eligible : true))
  },
})

// ---------- §L — Leave encashment request workflow ----------
// An employee with encashment-eligible balance can request a payout of unused
// days. Routed through the approval engine (ENCASHMENT process); approval
// adjusts the year's balance and queues an ENCASHMENT bonus for payroll pickup.
  // INTENTIONALLY_SELF_SCOPED (M-02): self-service encashment: handler scopes to ctx.employeeId + validates balance
route("leave.encash", {
  schema: S.leaveEncash,
  handler: async (ctx, p) => {
    const employeeId = ctx.role === "EMPLOYEE" ? ctx.employeeId : p.employeeId || ctx.employeeId
    if (!employeeId) throw new Deny("No employee profile linked", 400)
    if (ctx.role === "EMPLOYEE" && p.employeeId && p.employeeId !== ctx.employeeId) {
      throw new Deny("You can only request your own leave encashment")
    }
    // H-04/H-05 — client-supplied employeeId must resolve inside the caller's scope
    if (ctx.role !== "EMPLOYEE" && p.employeeId && p.employeeId !== ctx.employeeId) {
      await assertEmployeeVisible(ctx, p.employeeId)
    }
    const days = Number(p.days)
    if (!Number.isFinite(days) || days <= 0) throw new Deny("Encashment days must be positive")
    // LVE-104 — the current leave year under the fiscal-year keying (the
    // same row apply charges); LVE-105 — the spendable check honors the
    // carry-expiry window
    const encSettings = await getSettings(ctx.vendorId)
    const encMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    const encFy = Math.max(0, encMonths.indexOf(encSettings.general.fiscalYearStart || "July"))
    const year = leaveYearOf(today(), encFy)
    // H-7 — the balance row is scoped by the REQUESTED leave type. The old
    // unscoped findFirst({ employeeId, vendorId, year }) picked an ARBITRARY
    // row among the employee's leave types (no leaveTypeId filter, no
    // orderBy): the encashment could reserve days from one type while
    // validating eligibility and paying the rate of another —
    // non-deterministic money computation. (employeeId, leaveTypeId, year) is
    // the LeaveBalance unique key; the orderBy is defense-in-depth so the
    // query stays deterministic even if that constraint ever changes.
    const bal = await db.leaveBalance.findFirst({
      where: { employeeId, vendorId: ctx.vendorId, year, leaveTypeId: p.leaveTypeId },
      orderBy: { id: "asc" },
    })
    if (!bal) throw new Deny("No leave balance of this type for this year", 404)
    const type = await db.leaveType.findUnique({ where: { id: bal.leaveTypeId } })
    if (!type?.encashmentAllowed) throw new Deny(`${type?.name || "This leave type"} is not encashment-eligible`)
    // LVE-006 (R3-4) — encashmentCap is DAYS on BOTH encashment paths (the
    // exit settlement used to read the same column as TAKA and truncate the
    // payout to ৳cap; the schema comment and the Settings label now say days)
    if (type.encashmentCap > 0 && days > type.encashmentCap) {
      throw new Deny(`Encashment is capped at ${type.encashmentCap} day(s) per request for ${type.name}`)
    }
    // LVE-005 (R3-4) — H-9 discipline for encashment reservations: the old
    // flow read `remaining` OUTSIDE any transaction, then submitted the
    // approval and incremented `pending` as two separate awaits — two
    // concurrent leave.encash calls both passed the check and both reserved
    // (over-reservation). The remaining check now runs INSIDE a transaction
    // on a row locked FOR UPDATE, and the approval request + the reservation
    // commit atomically (mirroring leaveRequests.apply's H-14 shape).
    const { createApprovalRequest, announceApprovalRequest } = await import("../approval")
    const title = `Leave encashment — ${days} day(s) of ${type.name}`
    const payload = { employeeId, amount: days, leaveTypeId: type.id, days, year }
    const sub = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "LeaveBalance" WHERE "id" = ${bal.id} FOR UPDATE`
      const locked = await tx.leaveBalance.findUnique({ where: { id: bal.id } })
      // LVE-002 (R3-4) — canonical spendable formula (incl. carried-forward)
      const remaining = spendableDays(locked, {
        asOf: today(),
        fyStartMonth: encFy,
        carryForwardExpiryMonths: type.carryForwardExpiryMonths,
      })
      if (days > remaining) {
        throw new Deny(`Insufficient balance: ${remaining} day(s) remaining`)
      }
      const created = await createApprovalRequest(ctx, "ENCASHMENT", "LeaveBalance", bal.id, title, payload, tx)
      await tx.leaveBalance.update({ where: { id: bal.id }, data: { pending: { increment: days } } })
      return created
    })
    // post-commit side effects — NEVER inside the transaction (H-14)
    await announceApprovalRequest(ctx, "ENCASHMENT", "LeaveBalance", bal.id, sub.id, sub.restSeq, title, payload)
    await audit(ctx, "leave.encash", "LeaveBalance", bal.id, `Requested encashment of ${days} day(s) of ${type.name}`)
    return { approvalId: sub.id }
  },
})

/** ENCASHMENT finalize hook — adjusts balance and queues the payout bonus.
 *  LVE-005 (R3-4): the hook now receives the APPROVAL REQUEST ID from the
 *  engine (hooks.ts forwards req.id) and resolves the approval by id — the
 *  old entityId-only lookup was ambiguous whenever two encashment requests
 *  were open on the same balance row, applying the wrong payload or
 *  double-converting pending→used. The decrement is guarded-atomic (the
 *  exact H-9 anti-pattern the old absolute write from a stale read hit). */
export async function applyEncashmentDecision(ctx: { userId: string; userName: string; vendorId: string }, balanceId: string, decision: string, approvalId?: string) {
  const req = (approvalId
      ? await db.approvalRequest.findFirst({ where: { id: approvalId, vendorId: ctx.vendorId } })
      : (await db.approvalRequest.findFirst({ where: { processType: "ENCASHMENT", entityId: balanceId, status: "PENDING", vendorId: ctx.vendorId } }))
        || (await db.approvalRequest.findFirst({ where: { processType: "ENCASHMENT", entityId: balanceId, vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" } })))
  if (!req) return
  const payload = j(req.payloadJson, {}) as any
  const days = Number(payload.days || 0)
  if (days <= 0) return
  const bal = await db.leaveBalance.findFirst({ where: { id: balanceId, vendorId: ctx.vendorId } })
  if (!bal) return
  const type = await db.leaveType.findUnique({ where: { id: bal.leaveTypeId } })
  if (decision === "APPROVED") {
    // convert pending → used — guarded atomic decrement (H-9 pattern; the
    // old absolute `pending: Math.max(0, bal.pending - days)` write lost
    // updates when two decisions landed close together)
    const claimed = await db.leaveBalance.updateMany({
      where: { id: bal.id, pending: { gte: days } },
      data: { pending: { decrement: days }, used: { increment: days } },
    })
    if (claimed.count !== 1) {
      // short/corrupted reservation — clamp pending instead of going negative
      await db.leaveBalance.update({ where: { id: bal.id }, data: { pending: 0, used: { increment: days } } })
    }
    // queue the payout as a bonus so payroll picks it up in the next run
    if (type) {
      const rate = type.encashmentRate > 0 ? type.encashmentRate : 1
      // LVE-121 (R6) — vendor-scoped like every sibling salary-structure read
      const structure = await db.salaryStructure.findFirst({ where: { vendorId: ctx.vendorId, employeeId: bal.employeeId, status: "ACTIVE" } })
      // HIGH-5 — use the unified dailyRate helper instead of hardcoded /26.
      const daily = structure ? Math.round(dailyRate(structure.gross) * rate) : 0
      if (daily > 0) {
        const now = new Date()
        await db.bonus.create({
          data: {
            vendorId: ctx.vendorId, employeeId: bal.employeeId, type: "ENCASHMENT",
            calcType: "FIXED", amount: Math.round(daily * days),
            periodMonth: now.getMonth() + 1, periodYear: now.getFullYear(),
            label: `Leave encashment — ${days} day(s) ${type.name}`,
            status: "PENDING", createdBy: ctx.userId,
          },
        })
      }
    }
    await audit(ctx, "leave.encash.approve", "LeaveBalance", bal.id, `Encashed ${days} day(s) of ${type?.name}`)
  } else {
    // release the reservation — guarded atomic decrement
    const released = await db.leaveBalance.updateMany({
      where: { id: bal.id, pending: { gte: days } },
      data: { pending: { decrement: days } },
    })
    if (released.count !== 1) {
      await db.leaveBalance.update({ where: { id: bal.id }, data: { pending: 0 } })
    }
    await audit(ctx, "leave.encash.reject", "LeaveBalance", bal.id, `Encashment request rejected (${days} day(s) released)`)
  }
}

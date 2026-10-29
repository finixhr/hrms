// ============ Provident Fund (PF) routes ============
// Additive module riding the existing payroll/employee/permission patterns:
//   - vendor rules live in HrSettings group "pf" (Settings → Payroll → Provident Fund)
//   - per-employee enrollment: PfEnrollment (one row per employee)
//   - immutable ledger: PfContribution (written by payRun on PAID, manual or opening)
// Permissions reuse the payroll module (view/edit) — no new permission tree.
// Tenant isolation: every query is vendorId-scoped; branch/department managers
// see only employees inside employeeScopeFilter (same as payroll/loans).
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, assertEmployeeVisible, scopedEmployeeWhere } from "../rbac"
import { audit } from "../audit"
import { getSettings } from "../settings"
import * as XLSX from "xlsx"
import { generatePfOpeningTemplate, parseAndValidatePfRows, pfNoteHash } from "../pf-import"

const PF_STATUSES = ["ACTIVE", "PAUSED", "CLOSED"]

/** Decorated enrollment row: employee identity + computed balance. */
async function decorate(rows: any[], ctx: any) {
  const ids = rows.map((r) => r.employeeId)
  const employees = ids.length
    ? await db.employee.findMany({
        where: { vendorId: ctx.vendorId, id: { in: ids } },
        select: {
          id: true,
          code: true,
          fullName: true,
          status: true,
          joiningDate: true,
          branchId: true,
          department: { select: { name: true } },
          designation: { select: { name: true } },
        },
      })
    : []
  const empById = new Map(employees.map((e) => [e.id, e]))
  const contributions = await db.pfContribution.groupBy({
    by: ["employeeId"],
    where: { vendorId: ctx.vendorId, employeeId: { in: ids } },
    _sum: { employeeAmount: true, employerAmount: true },
    _count: true,
  })
  const totals = new Map(contributions.map((c) => [c.employeeId, c]))
  return rows.map((r) => {
    const e = empById.get(r.employeeId)
    const t = totals.get(r.employeeId)
    const empSum = t?._sum.employeeAmount || 0
    const mgrSum = t?._sum.employerAmount || 0
    return {
      ...r,
      employeeCode: e?.code || "—",
      employeeName: e?.fullName || "—",
      employeeStatus: e?.status || null,
      joiningDate: e?.joiningDate || null,
      departmentName: e?.department?.name || null,
      designationName: e?.designation?.name || null,
      employeeTotal: empSum,
      employerTotal: mgrSum,
      balance: empSum + mgrSum,
      months: t?._count || 0,
    }
  })
}

// ---------- enrollment list (payroll view) ----------
route("pf.list", {
  perm: ["payroll", "view"],
  handler: async (ctx) => {
    // H-04/H-05 — manager-facing list: scope-limited by default
    const scope = await scopedEmployeeWhere(ctx)
    const rows = await db.pfEnrollment.findMany({ where: { vendorId: ctx.vendorId, ...scope }, orderBy: { createdAt: "desc" } })
    return decorate(rows, ctx)
  },
})

// ---------- enroll / update an employee ----------
route("pf.enroll", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const s = await getSettings(ctx.vendorId)
    const employeePct = Number(p.employeePct ?? s.pf.employeePct)
    const employerPct = Number(p.employerPct ?? s.pf.employerPct)
    const basis = p.basis === "GROSS" ? "GROSS" : p.basis === "BASIC" ? "BASIC" : s.pf.basis
    if (!Number.isFinite(employeePct) || employeePct < 0 || employeePct > 100) throw new Deny("Employee contribution must be between 0 and 100%", 400)
    if (!Number.isFinite(employerPct) || employerPct < 0 || employerPct > 100) throw new Deny("Employer contribution must be between 0 and 100%", 400)

    const existing = await db.pfEnrollment.findFirst({ where: { vendorId: ctx.vendorId, employeeId: emp.id } })
    let rec
    if (existing) {
      if (existing.status === "CLOSED") throw new Deny("This enrollment is closed — re-enroll after reopening if needed", 400)
      rec = await db.pfEnrollment.update({
        where: { id: existing.id },
        data: {
          employeePct, employerPct, basis,
          status: PF_STATUSES.includes(p.status) ? p.status : existing.status,
          note: p.note != null ? String(p.note).slice(0, 300) : existing.note,
        },
      })
    } else {
      const eligibleStatuses = s.pf.eligibleStatuses?.length
        ? s.pf.eligibleStatuses
        : ["ACTIVE", "PROBATION"]
      if (emp.status && !eligibleStatuses.includes(emp.status)) {
        throw new Deny(`${emp.fullName} has status "${emp.status}" — only employees with status [${eligibleStatuses.join(", ")}] are eligible for Provident Fund under Settings → Payroll → Provident Fund`, 400)
      }
      if (s.pf.minServiceMonths > 0 && emp.joiningDate) {
        const months = (Date.now() - new Date(emp.joiningDate + "T00:00:00").getTime()) / (30.44 * 86400000)
        if (months < s.pf.minServiceMonths) {
          throw new Deny(`${emp.fullName} has ${months.toFixed(1)} month(s) of service — the policy requires ${s.pf.minServiceMonths} (Settings → Payroll → Provident Fund)`, 400)
        }
      }
      rec = await db.pfEnrollment.create({
        data: {
          vendorId: ctx.vendorId, employeeId: emp.id,
          enrollDate: p.enrollDate || new Date().toISOString().slice(0, 10),
          status: "ACTIVE", employeePct, employerPct, basis,
          note: p.note != null ? String(p.note).slice(0, 300) : null,
          createdBy: ctx.userId,
        },
      })
    }
    await audit(ctx, existing ? "pf.update" : "pf.enroll", "PfEnrollment", rec.id,
      `${existing ? "Updated" : "Enrolled"} PF for ${emp.fullName} (${emp.code}) — employee ${employeePct}% / employer ${employerPct}% on ${basis}`,
      { newValue: { employeePct, employerPct, basis } })
    return rec
  },
})

// ---------- close / reopen enrollment ----------
route("pf.setStatus", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const rec = await db.pfEnrollment.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Enrollment not found", 404)
    if (!PF_STATUSES.includes(p.status)) throw new Deny("Status must be ACTIVE, PAUSED or CLOSED", 400)
    const updated = await db.pfEnrollment.update({
      where: { id: rec.id },
      data: { status: p.status, closedAt: p.status === "CLOSED" ? new Date() : null },
    })
    await audit(ctx, "pf.setStatus", "PfEnrollment", rec.id, `PF enrollment → ${p.status}`)
    return updated
  },
})

// ---------- per-employee statement (ledger) ----------
route("pf.statement", {
  perm: ["payroll", "view"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const [enrollment, contributions, runs] = await Promise.all([
      db.pfEnrollment.findFirst({ where: { vendorId: ctx.vendorId, employeeId: emp.id } }),
      db.pfContribution.findMany({ where: { vendorId: ctx.vendorId, employeeId: emp.id }, orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, { createdAt: "desc" }] }),
      db.payrollRun.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, periodMonth: true, periodYear: true, status: true } }),
    ])
    const runById = new Map(runs.map((r) => [r.id, r]))
    let employeeTotal = 0, employerTotal = 0
    const ledger = contributions.map((c) => {
      employeeTotal += c.employeeAmount
      employerTotal += c.employerAmount
      const run = c.runId ? runById.get(c.runId) : null
      return {
        ...c,
        runStatus: run?.status || null,
        period: `${run?.periodYear || c.periodYear}-${String(c.periodMonth).padStart(2, "0")}`,
      }
    })
    return {
      employee: { id: emp.id, code: emp.code, fullName: emp.fullName, joiningDate: emp.joiningDate, status: emp.status },
      enrollment,
      ledger,
      employeeTotal,
      employerTotal,
      balance: employeeTotal + employerTotal,
    }
  },
})

// ---------- manual / opening / withdrawal entry ----------
route("pf.contribution.add", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const source = ["MANUAL", "OPENING", "WITHDRAWAL"].includes(p.source) ? p.source : "MANUAL"
    const year = Number(p.periodYear), month = Number(p.periodMonth)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Deny("Invalid period year", 400)
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Deny("Invalid period month (1-12)", 400)
    const employeeAmount = Math.round(Number(p.employeeAmount) || 0)
    const employerAmount = Math.round(Number(p.employerAmount) || 0)
    if (employeeAmount < 0 || employerAmount < 0) throw new Deny("Contribution amounts cannot be negative", 400)
    if (employeeAmount === 0 && employerAmount === 0) throw new Deny("Enter an employee and/or employer amount", 400)
    if (source === "WITHDRAWAL" && employeeAmount === 0 && employerAmount === 0) throw new Deny("Withdrawal requires an amount", 400)

    const note = p.note != null ? String(p.note).slice(0, 300) : null
    const rec = await db.pfContribution.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id,
        periodYear: year, periodMonth: month,
        // withdrawals are stored as negative movements on the ledger
        employeeAmount: source === "WITHDRAWAL" ? -employeeAmount : employeeAmount,
        employerAmount: source === "WITHDRAWAL" ? -employerAmount : employerAmount,
        source, note, noteHash: pfNoteHash(note, source), createdBy: ctx.userId,
      },
    })
    await audit(ctx, "pf.contribution.add", "PfContribution", rec.id,
      `PF ${source.toLowerCase()} for ${emp.fullName}: ৳${employeeAmount} employee / ৳${employerAmount} employer (${year}-${String(month).padStart(2, "0")})`)
    return rec
  },
})

// ---------- period report (vendor-wide) ----------
route("pf.report", {
  perm: ["payroll", "view"],
  handler: async (ctx, p) => {
    const year = Number(p?.year) || new Date().getFullYear()
    const month = p?.month ? Number(p.month) : null
    const where: any = { vendorId: ctx.vendorId, periodYear: year }
    if (month) where.periodMonth = month
    const rows = await db.pfContribution.findMany({ where, orderBy: [{ periodMonth: "asc" }, { createdAt: "asc" }] })
    const enrollments = await db.pfEnrollment.findMany({ where: { vendorId: ctx.vendorId, status: "ACTIVE" }, select: { employeeId: true } })
    const byEmployee = new Map<string, { employeeAmount: number; employerAmount: number }>()
    for (const r of rows) {
      const cur = byEmployee.get(r.employeeId) || { employeeAmount: 0, employerAmount: 0 }
      cur.employeeAmount += r.employeeAmount
      cur.employerAmount += r.employerAmount
      byEmployee.set(r.employeeId, cur)
    }
    const ids = [...byEmployee.keys()]
    const employees = ids.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: ids } }, select: { id: true, code: true, fullName: true } })
      : []
    return {
      year, month: month || null,
      activeEnrollments: enrollments.length,
      totalEmployee: rows.reduce((s, r) => s + r.employeeAmount, 0),
      totalEmployer: rows.reduce((s, r) => s + r.employerAmount, 0),
      byEmployee: employees.map((e) => ({
        employeeId: e.id, code: e.code, name: e.fullName,
        employeeAmount: byEmployee.get(e.id)?.employeeAmount || 0,
        employerAmount: byEmployee.get(e.id)?.employerAmount || 0,
      })),
    }
  },
})

// ---------- auto-enroll run (triggered when autoEnroll setting is ON) ----------
// Scans all ACTIVE employees, skips those already enrolled (any status), applies
// the minServiceMonths gate, and creates ACTIVE PfEnrollment rows using the
// vendor-default rates. Returns { enrolled, skipped, ineligible } for the UI.
route("pf.autoEnrollRun", {
  perm: ["payroll", "edit"],
  handler: async (ctx) => {
    const s = await getSettings(ctx.vendorId)
    if (!s.pf.enabled) throw new Deny("Provident Fund is disabled in Settings → Payroll → Provident Fund", 400)
    if (!s.pf.autoEnroll) throw new Deny("Auto Enroll is disabled in Settings → Payroll → Provident Fund", 400)

    // Fetch employees matching eligible statuses for this vendor
    const eligibleStatuses = s.pf.eligibleStatuses?.length
      ? s.pf.eligibleStatuses
      : ["ACTIVE", "PROBATION"]

    const employees = await db.employee.findMany({
      where: { vendorId: ctx.vendorId, status: { in: eligibleStatuses } },
      select: { id: true, code: true, fullName: true, status: true, joiningDate: true },
    })

    // Fetch existing enrollments (any status) to skip already-enrolled employees
    const existingEnrollments = await db.pfEnrollment.findMany({
      where: { vendorId: ctx.vendorId },
      select: { employeeId: true },
    })
    const enrolledIds = new Set(existingEnrollments.map((e) => e.employeeId))

    const today = new Date()
    const enrollDate = today.toISOString().slice(0, 10)
    const { employeePct, employerPct, basis, minServiceMonths } = s.pf

    let enrolled = 0
    let skipped = 0
    let ineligible = 0
    const enrolledNames: string[] = []
    const ineligibleReasons: string[] = []

    for (const emp of employees) {
      // Already has any enrollment record — skip (don't overwrite manual configs)
      if (enrolledIds.has(emp.id)) {
        skipped++
        continue
      }

      // Service period eligibility check
      if (minServiceMonths > 0 && emp.joiningDate) {
        const months = (today.getTime() - new Date(emp.joiningDate + "T00:00:00").getTime()) / (30.44 * 86400000)
        if (months < minServiceMonths) {
          ineligible++
          ineligibleReasons.push(`${emp.fullName} (${emp.code}): ${months.toFixed(1)}/${minServiceMonths} months`)
          continue
        }
      }

      // Create the enrollment with vendor-default rates
      const rec = await db.pfEnrollment.create({
        data: {
          vendorId: ctx.vendorId,
          employeeId: emp.id,
          enrollDate,
          status: "ACTIVE",
          employeePct,
          employerPct,
          basis,
          note: "Auto-enrolled via Settings → Payroll → Provident Fund (autoEnroll)",
          createdBy: ctx.userId,
        },
      })
      await audit(
        ctx,
        "pf.enroll",
        "PfEnrollment",
        rec.id,
        `Auto-enrolled ${emp.fullName} (${emp.code}) in PF — employee ${employeePct}% / employer ${employerPct}% on ${basis}`,
        { newValue: { employeePct, employerPct, basis, auto: true } },
      )
      enrolled++
      enrolledNames.push(`${emp.fullName} (${emp.code})`)
    }

    return { enrolled, skipped, ineligible, enrolledNames, ineligibleReasons }
  },
})

// ---------- download pre-filled opening balance template ----------
route("pf.template.download", {
  perm: ["payroll", "view"],
  handler: async (ctx, p) => {
    const filter = (p?.filter as string) || "ELIGIBLE" // "ELIGIBLE" | "ENROLLED" | "ALL"
    const s = await getSettings(ctx.vendorId)

    const eligibleStatuses = s.pf.eligibleStatuses?.length
      ? s.pf.eligibleStatuses
      : ["ACTIVE", "PROBATION"]

    const employees = await db.employee.findMany({
      where: { vendorId: ctx.vendorId },
      include: {
        department: { select: { name: true } },
        designation: { select: { name: true } },
      },
      orderBy: { code: "asc" },
    })

    const enrollments = await db.pfEnrollment.findMany({
      where: { vendorId: ctx.vendorId, status: "ACTIVE" },
      select: { employeeId: true },
    })
    const enrolledIds = new Set(enrollments.map((e) => e.employeeId))

    const empIds = employees.map((e) => e.id)
    const structures = await db.salaryStructure.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, status: "ACTIVE" },
      select: { employeeId: true, basic: true, gross: true },
    })
    const structMap = new Map(structures.map((s) => [s.employeeId, s]))

    const today = Date.now()
    const analyzedEmployees = employees.map((e) => {
      let isEligible = true
      let pfStatus = "Eligible"

      if (!eligibleStatuses.includes(e.status)) {
        isEligible = false
        pfStatus = `Ineligible (${e.status})`
      } else if (enrolledIds.has(e.id)) {
        isEligible = true
        pfStatus = "Enrolled"
      } else if (s.pf.minServiceMonths > 0) {
        if (e.joiningDate) {
          const months = (today - new Date(e.joiningDate + "T00:00:00").getTime()) / (30.44 * 86400000)
          if (months < s.pf.minServiceMonths) {
            isEligible = false
            pfStatus = `Ineligible (${months.toFixed(1)}/${s.pf.minServiceMonths}m service)`
          } else {
            pfStatus = `Eligible (${months.toFixed(1)}m service)`
          }
        } else {
          isEligible = false
          pfStatus = "Ineligible (No joining date)"
        }
      }

      return {
        ...e,
        isEligible,
        pfStatus,
      }
    })

    const filtered = analyzedEmployees.filter((e) => {
      if (filter === "ENROLLED") return enrolledIds.has(e.id)
      if (filter === "ELIGIBLE") return e.isEligible
      return true // "ALL"
    })

    const buffer = generatePfOpeningTemplate({
      employees: filtered.map((e) => ({
        id: e.id,
        code: e.code,
        fullName: e.fullName,
        departmentName: e.department?.name,
        designationName: e.designation?.name,
        basicSalary: structMap.get(e.id)?.basic || 0,
        grossSalary: structMap.get(e.id)?.gross || 0,
        pfStatus: e.pfStatus,
      })),
      currentYear: new Date().getFullYear(),
      currentMonth: new Date().getMonth() + 1,
    })

    const filterSuffix = filter === "ENROLLED" ? "_Enrolled" : filter === "ALL" ? "_All_Employees" : "_Eligible"
    return {
      fileName: `PF_Opening_Balances${filterSuffix}_${new Date().toISOString().slice(0, 10)}.xlsx`,
      base64: buffer.toString("base64"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
  },
})

// ---------- preview bulk opening/historical PF import ----------
route("pf.import.preview", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    let rows: any[] = []
    if (p.base64) {
      const buf = Buffer.from(p.base64, "base64")
      const wb = XLSX.read(buf, { type: "buffer" })
      const sheetName = wb.SheetNames.includes("PF_Opening_Balances") ? "PF_Opening_Balances" : wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]
      rows = XLSX.utils.sheet_to_json(ws)
    } else if (Array.isArray(p.rows)) {
      rows = p.rows
    } else {
      throw new Deny("No file content or rows provided", 400)
    }

    const employees = await db.employee.findMany({
      where: { vendorId: ctx.vendorId },
      include: {
        department: { select: { name: true } },
        designation: { select: { name: true } },
      },
    })
    const enrollments = await db.pfEnrollment.findMany({
      where: { vendorId: ctx.vendorId },
      select: { employeeId: true },
    })
    const enrolledSet = new Set(enrollments.map((en) => en.employeeId))

    const empList = employees.map((e) => ({
      id: e.id,
      code: e.code,
      fullName: e.fullName,
      departmentName: e.department?.name,
      designationName: e.designation?.name,
      enrolledInPf: enrolledSet.has(e.id),
    }))

    const preview = parseAndValidatePfRows(rows, empList)
    return preview
  },
})

// ---------- execute bulk opening/historical PF import ----------
route("pf.import.execute", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    let rawRows: any[] = []
    if (p.base64) {
      const buf = Buffer.from(p.base64, "base64")
      const wb = XLSX.read(buf, { type: "buffer" })
      const sheetName = wb.SheetNames.includes("PF_Opening_Balances") ? "PF_Opening_Balances" : wb.SheetNames[0]
      rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName])
    } else if (Array.isArray(p.rows)) {
      rawRows = p.rows
    } else {
      throw new Deny("No file content or rows provided", 400)
    }

    const employees = await db.employee.findMany({
      where: { vendorId: ctx.vendorId },
      include: {
        department: { select: { name: true } },
        designation: { select: { name: true } },
      },
    })
    const enrollments = await db.pfEnrollment.findMany({
      where: { vendorId: ctx.vendorId },
      select: { employeeId: true },
    })
    const enrolledSet = new Set(enrollments.map((en) => en.employeeId))

    const empList = employees.map((e) => ({
      id: e.id,
      code: e.code,
      fullName: e.fullName,
      departmentName: e.department?.name,
      designationName: e.designation?.name,
      enrolledInPf: enrolledSet.has(e.id),
    }))

    const preview = parseAndValidatePfRows(rawRows, empList)
    const readyItems = preview.items.filter((item) => item.status === "READY" && item.employeeId)

    if (readyItems.length === 0) {
      throw new Deny("No valid records found to import. All rows are either skipped (zero amount) or have errors.", 400)
    }

    const s = await getSettings(ctx.vendorId)
    const today = new Date().toISOString().slice(0, 10)

    const eligibleStatuses = s.pf.eligibleStatuses?.length
      ? s.pf.eligibleStatuses
      : ["ACTIVE", "PROBATION"]
    const empById = new Map(employees.map((e) => [e.id, e]))

    let autoEnrolledCount = 0
    let importedCount = 0
    let duplicateCount = 0
    let totalEmployeeAmount = 0
    let totalEmployerAmount = 0

    // MON-3 (Phase 1) — the whole import is ONE transaction built around the
    // new (vendorId, employeeId, period, source, noteHash) unique:
    //   - a retry after a partial failure re-inserts nothing (the earlier
    //     committed rows of the same batch dedupe on contact);
    //   - a double upload of the same file inserts nothing;
    //   - an intentional additional contribution with DIFFERENT note text
    //     still lands (different noteHash).
    // The old per-row sequential create had no idempotency at all — every
    // duplicate inflated the employee's exit settlement payout.
    await db.$transaction(async (tx) => {
      // Auto-enroll non-enrolled employees (matching eligible status)
      for (const item of readyItems) {
        if (!item.employeeId) continue
        const emp = empById.get(item.employeeId)
        const isEligibleStatus = emp?.status ? eligibleStatuses.includes(emp.status) : true
        if (!enrolledSet.has(item.employeeId) && isEligibleStatus) {
          await tx.pfEnrollment.create({
            data: {
              vendorId: ctx.vendorId,
              employeeId: item.employeeId,
              enrollDate: today,
              status: "ACTIVE",
              employeePct: s.pf.employeePct,
              employerPct: s.pf.employerPct,
              basis: s.pf.basis,
              note: "Auto-enrolled upon historical/opening PF balance import",
              createdBy: ctx.userId,
            },
          })
          enrolledSet.add(item.employeeId)
          autoEnrolledCount++
        }
      }

      const rows = readyItems
        .filter((item) => item.employeeId)
        .map((item) => ({
          vendorId: ctx.vendorId,
          employeeId: item.employeeId as string,
          periodYear: item.year,
          periodMonth: item.month,
          employeeAmount: item.employeeAmount,
          employerAmount: item.employerAmount,
          source: item.source || "OPENING",
          note: item.note || "Opening balance carried from previous system",
          noteHash: pfNoteHash(item.note || "Opening balance carried from previous system", item.source || "OPENING"),
          createdBy: ctx.userId,
        }))
      if (!rows.length) return

      // Probe FIRST: which of this batch's unique keys are already stored?
      // createMany(skipDuplicates) reports only a count, not WHICH rows were
      // skipped — the probe lets the summary and audit carry exact per-row
      // accounting (imported vs duplicate) and exact money totals.
      const probe = await tx.pfContribution.findMany({
        where: {
          vendorId: ctx.vendorId,
          OR: rows.map((r) => ({
            employeeId: r.employeeId,
            periodYear: r.periodYear,
            periodMonth: r.periodMonth,
            source: r.source,
            noteHash: r.noteHash,
          })),
        },
        select: { employeeId: true, periodYear: true, periodMonth: true, source: true, noteHash: true },
      })
      const keyOf = (e: { employeeId: string; periodYear: number; periodMonth: number; source: string; noteHash: string }) =>
        `${e.employeeId}|${e.periodYear}|${e.periodMonth}|${e.source}|${e.noteHash}`
      const existing = new Set(probe.map(keyOf))
      const freshRows = rows.filter((r) => !existing.has(keyOf(r)))
      duplicateCount = rows.length - freshRows.length
      importedCount = freshRows.length
      for (const r of freshRows) {
        totalEmployeeAmount += r.employeeAmount
        totalEmployerAmount += r.employerAmount
      }
      if (freshRows.length) {
        // skipDuplicates is the DB-level backstop (races with a concurrent
        // import of the same keys between probe and insert)
        await tx.pfContribution.createMany({ data: freshRows as any, skipDuplicates: true })
      }
    })

    await audit(
      ctx,
      "pf.import",
      "PfContribution",
      ctx.vendorId,
      `Imported ${importedCount} PF historical/opening records: ৳${totalEmployeeAmount} employee / ৳${totalEmployerAmount} employer (auto-enrolled ${autoEnrolledCount} employees${duplicateCount > 0 ? `; ${duplicateCount} duplicate row(s) skipped by the idempotency key` : ""})`,
      {
        newValue: {
          importedCount,
          duplicateCount,
          autoEnrolledCount,
          totalEmployeeAmount,
          totalEmployerAmount,
          totalCombined: totalEmployeeAmount + totalEmployerAmount,
        },
      }
    )

    return {
      success: true,
      importedCount,
      // MON-3 — rows of this batch already stored under the idempotency key
      duplicateCount,
      autoEnrolledCount,
      totalEmployeeAmount,
      totalEmployerAmount,
      totalCombined: totalEmployeeAmount + totalEmployerAmount,
    }
  },
})

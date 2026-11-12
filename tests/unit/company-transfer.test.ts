/// <reference types="bun-types" />
// ============ Employee company transfer ============
// The contract: a transfer closes one employment and opens another. Nothing that
// happened under the source company moves, changes or disappears.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { applyCompanyTransfer, applyDueCompanyTransfers, decideCompanyTransfer, employmentChainIds, transferBlockers } from "@/hrm-server/company-transfer"
import { calculateRun } from "@/hrm-server/payroll"
import { usageSnapshot } from "@/hrm-server/saas/entitlements"
import { addDays, today } from "@/hrm-server/utils"

const TODAY = today()

/** A tenant with companies A and B, an owner, and org rows in both. */
async function world() {
  const vendor = await mkVendor(uniq("Transfer Co"))
  const companyA = (await defaultCompanyId(vendor.id))!
  const companyB = (await db.company.create({ data: { vendorId: vendor.id, code: uniq("B").slice(-10), name: "Company B", active: true } })).id
  const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
  const tokenA = await mkSession(owner.id)
  const mkOrg = async (companyId: string, label: string) => ({
    branch: await db.branch.create({ data: { vendorId: vendor.id, companyId, name: `${label} HQ`, code: uniq("BR") } }),
    department: await db.department.create({ data: { vendorId: vendor.id, companyId, name: `${label} Ops`, code: uniq("DP") } }),
    designation: await db.designation.create({ data: { vendorId: vendor.id, companyId, name: `${label} Officer`, code: uniq("DS") } }),
    shift: await db.shift.create({ data: { vendorId: vendor.id, companyId, name: `${label} Day`, startTime: "09:00", endTime: "17:00" } }),
  })
  const orgA = await mkOrg(companyA, "A")
  const orgB = await mkOrg(companyB, "B")
  // the owner operating in company B
  await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: owner.id, companyId: companyB, role: "VENDOR_OWNER", active: true } })
  const ownerB = await mkSession(owner.id)
  await db.session.update({ where: { tokenHash: (await import("@/hrm-server/auth")).sessionTokenHash(ownerB) }, data: { activeCompanyId: companyB } })
  return { vendor, companyA, companyB, owner, tokenA, tokenB: ownerB, orgA, orgB }
}
type World = Awaited<ReturnType<typeof world>>

async function mkStaff(w: World, over: Record<string, unknown> = {}) {
  const emp = await db.employee.create({
    data: {
      vendorId: w.vendor.id, companyId: w.companyA, fullName: "Ayesha Rahman", code: uniq("E").slice(-14),
      mobile: `017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, officialEmail: `${uniq("ayesha")}@test.local`,
      joiningDate: "2023-03-01", employmentType: "PERMANENT", status: "ACTIVE",
      branchId: w.orgA.branch.id, departmentId: w.orgA.department.id, designationId: w.orgA.designation.id, shiftId: w.orgA.shift.id,
      ...over,
    } as any,
  })
  await db.salaryStructure.create({ data: { vendorId: w.vendor.id, employeeId: emp.id, effectiveFrom: "2023-03-01", status: "ACTIVE", basic: 30000, houseRent: 15000, medical: 5000, conveyance: 2000, gross: 52000 } as any })
  return emp
}

const request = (w: World, emp: { id: string }, over: Record<string, unknown> = {}) =>
  db.companyTransfer.create({
    data: {
      vendorId: w.vendor.id, fromEmployeeId: emp.id, fromCompanyId: w.companyA, toCompanyId: w.companyB,
      toBranchId: w.orgB.branch.id, toDepartmentId: w.orgB.department.id, toDesignationId: w.orgB.designation.id, toShiftId: w.orgB.shift.id,
      fromCode: (emp as any).code, toCode: (emp as any).code,
      requestedEffectiveDate: TODAY, effectiveDate: TODAY, reason: "Group restructuring", status: "PENDING",
      ...over,
    } as any,
  })

/** Approve and apply, returning both employment records. */
async function transfer(w: World, emp: { id: string }, over: Record<string, unknown> = {}) {
  const t = await request(w, emp, over)
  await decideCompanyTransfer(t.id, w.owner.id, w.vendor.id, "APPROVED")
  const after = await db.companyTransfer.findUniqueOrThrow({ where: { id: t.id } })
  expect(after.status).toBe("COMPLETED")
  return {
    t: after,
    oldRow: await db.employee.findUniqueOrThrow({ where: { id: emp.id } }),
    newRow: await db.employee.findUniqueOrThrow({ where: { id: after.toEmployeeId! } }),
  }
}

describe("the transition", () => {
  let w: World
  beforeAll(async () => { w = await world() })

  test("closes the old employment and opens a linked one in the destination", async () => {
    const emp = await mkStaff(w)
    const { oldRow, newRow, t } = await transfer(w, emp)

    expect(oldRow.companyId).toBe(w.companyA) // never moved
    expect(oldRow.status).toBe("TRANSFERRED")
    expect(oldRow.transferredOutDate).toBe(TODAY)
    expect(oldRow.transferredToEmployeeId).toBe(newRow.id)
    expect(oldRow.branchId).toBe(w.orgA.branch.id) // history keeps its org context

    expect(newRow.companyId).toBe(w.companyB)
    expect(newRow.branchId).toBe(w.orgB.branch.id)
    expect(newRow.departmentId).toBe(w.orgB.department.id)
    expect(newRow.status).toBe("ACTIVE")
    expect(newRow.joiningDate).toBe(TODAY)
    expect(newRow.serviceStartDate).toBe("2023-03-01") // continuous service survives
    expect(newRow.priorEmployeeId).toBe(oldRow.id)
    expect(newRow.fullName).toBe(emp.fullName)

    expect(t.appliedAt).not.toBeNull()
    expect(await employmentChainIds(w.vendor.id, newRow.id)).toEqual([oldRow.id, newRow.id])
    expect(await employmentChainIds(w.vendor.id, oldRow.id)).toEqual([oldRow.id, newRow.id])
  })

  test("contact details move to the live record and the old values are kept in the snapshot", async () => {
    const emp = await mkStaff(w)
    const { oldRow, newRow, t } = await transfer(w, emp)
    expect(newRow.mobile).toBe(emp.mobile)
    expect(newRow.officialEmail).toBe(emp.officialEmail)
    expect(oldRow.mobile).toBeNull()
    const snap = JSON.parse(t.sourceSnapshotJson)
    expect(snap.mobile).toBe(emp.mobile)
    expect(snap.officialEmail).toBe(emp.officialEmail)
    expect(snap.branchId).toBe(w.orgA.branch.id)
  })

  test("every kind of history stays on the original record, untouched", async () => {
    const emp = await mkStaff(w)
    const v = w.vendor.id
    const att = await db.attendance.create({ data: { vendorId: v, employeeId: emp.id, date: addDays(TODAY, -3), status: "PRESENT", source: "BIOMETRIC" } })
    const type = await db.leaveType.create({ data: { vendorId: v, companyId: w.companyA, code: uniq("OLD"), name: "Old Leave", paid: true, defaultDays: 10 } as any })
    const leave = await db.leaveRequest.create({ data: { vendorId: v, employeeId: emp.id, leaveTypeId: type.id, fromDate: "2025-01-05", toDate: "2025-01-06", days: 2, status: "APPROVED", reason: "x" } as any })
    const run = await db.payrollRun.create({ data: { vendorId: v, companyId: w.companyA, periodMonth: 1, periodYear: 2025, status: "PAID", employeeCount: 1 } as any })
    const entry = await db.payrollEntry.create({ data: { vendorId: v, runId: run.id, employeeId: emp.id, status: "INCLUDED", gross: 52000, net: 50000, ait: 1000, payslipNumber: uniq("PS"), breakdownJson: "{}" } })
    const loan = await db.loan.create({ data: { vendorId: v, employeeId: emp.id, principal: 5000, outstanding: 0, paidAmount: 5000, status: "CLOSED", startDate: "2024-01-01" } as any })
    const advance = await db.advance.create({ data: { vendorId: v, employeeId: emp.id, amount: 1000, deducted: 1000, outstanding: 0, status: "RECOVERED", reason: "x", requestDate: "2024-01-01" } as any })
    const cycle = await db.reviewCycle.create({ data: { vendorId: v, companyId: w.companyA, name: "2024 Review", year: 2024, startDate: "2024-01-01", endDate: "2024-12-31" } })
    const review = await db.performanceReview.create({ data: { vendorId: v, cycleId: cycle.id, employeeId: emp.id, overallRating: 4 } })
    const doc = await db.employeeDocument.create({ data: { vendorId: v, employeeId: emp.id, category: "IDENTITY", docType: "NID", title: "NID", fileData: "abc" } as any })
    const history = await db.employeeHistory.create({ data: { vendorId: v, employeeId: emp.id, eventType: "JOINED", title: "Joined" } })
    const oldStructure = await db.salaryStructure.findFirstOrThrow({ where: { employeeId: emp.id } })

    const { oldRow, newRow } = await transfer(w, emp)

    expect((await db.attendance.findUniqueOrThrow({ where: { id: att.id } })).employeeId).toBe(oldRow.id)
    expect((await db.leaveRequest.findUniqueOrThrow({ where: { id: leave.id } })).employeeId).toBe(oldRow.id)
    expect((await db.payrollEntry.findUniqueOrThrow({ where: { id: entry.id } })).employeeId).toBe(oldRow.id)
    expect((await db.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).companyId).toBe(w.companyA)
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.id } })).employeeId).toBe(oldRow.id)
    expect((await db.advance.findUniqueOrThrow({ where: { id: advance.id } })).employeeId).toBe(oldRow.id)
    expect((await db.performanceReview.findUniqueOrThrow({ where: { id: review.id } })).employeeId).toBe(oldRow.id)
    expect((await db.employeeDocument.findUniqueOrThrow({ where: { id: doc.id } })).employeeId).toBe(oldRow.id)
    expect((await db.employeeHistory.findUniqueOrThrow({ where: { id: history.id } })).employeeId).toBe(oldRow.id)
    expect((await db.salaryStructure.findUniqueOrThrow({ where: { id: oldStructure.id } })).gross).toBe(52000)

    // none of it was duplicated onto the new employment…
    expect(await db.attendance.count({ where: { employeeId: newRow.id } })).toBe(0)
    expect(await db.payrollEntry.count({ where: { employeeId: newRow.id } })).toBe(0)
    expect(await db.leaveRequest.count({ where: { employeeId: newRow.id } })).toBe(0)
    expect(await db.loan.count({ where: { employeeId: newRow.id } })).toBe(0)
    // …except the reference documents a working employee needs
    expect(await db.employeeDocument.count({ where: { employeeId: newRow.id } })).toBe(1)
  })

  test("salary, bank and PF continue on the new record", async () => {
    const emp = await mkStaff(w)
    const v = w.vendor.id
    await db.bankAccount.create({ data: { vendorId: v, employeeId: emp.id, bank: "City Bank", accountNumber: "123", isSalaryPayoutAccount: true } as any })
    await db.pfEnrollment.create({ data: { vendorId: v, employeeId: emp.id, enrollDate: "2024-01-01", status: "ACTIVE" } as any })
    const { oldRow, newRow } = await transfer(w, emp)

    const live = await db.salaryStructure.findFirstOrThrow({ where: { employeeId: newRow.id } })
    expect(live.status).toBe("ACTIVE")
    expect(live.gross).toBe(52000)
    expect(live.effectiveFrom).toBe(TODAY)
    const closed = await db.salaryStructure.findFirstOrThrow({ where: { employeeId: oldRow.id } })
    expect(closed.status).toBe("SUPERSEDED")
    expect(closed.effectiveTo).toBe(addDays(TODAY, -1))
    expect(await db.bankAccount.count({ where: { employeeId: newRow.id, bank: "City Bank", isSalaryPayoutAccount: true } })).toBe(1)
    expect(await db.bankAccount.count({ where: { employeeId: oldRow.id } })).toBe(1)
    expect((await db.pfEnrollment.findFirstOrThrow({ where: { employeeId: newRow.id } })).enrollDate).toBe(TODAY)
  })

  test("the record of the move is complete on both sides", async () => {
    const emp = await mkStaff(w)
    const { oldRow, newRow, t } = await transfer(w, emp)
    expect(t.fromCompanyId).toBe(w.companyA)
    expect(t.toCompanyId).toBe(w.companyB)
    expect(t.effectiveDate).toBe(TODAY)
    expect(t.reason).toBe("Group restructuring")
    expect(t.decidedById).toBe(w.owner.id)
    expect((await db.employeeHistory.findFirstOrThrow({ where: { employeeId: oldRow.id, eventType: "COMPANY_TRANSFER_OUT" } })).title).toContain("Company B")
    expect(await db.employeeHistory.count({ where: { employeeId: newRow.id, eventType: "COMPANY_TRANSFER_IN" } })).toBe(1)
    expect(await db.auditLog.count({ where: { vendorId: w.vendor.id, action: "companyTransfer.apply", entityId: t.id } })).toBe(1)
  })

  test("applying twice is impossible", async () => {
    const emp = await mkStaff(w)
    const { t } = await transfer(w, emp)
    expect((await applyCompanyTransfer(t.id, w.vendor.id, w.owner.id)).applied).toBe(false)
    expect(await db.employee.count({ where: { priorEmployeeId: emp.id } })).toBe(1)
  })

  test("a transfer back opens a third record and keeps the whole chain", async () => {
    const emp = await mkStaff(w)
    const { newRow } = await transfer(w, emp)
    const back = await db.companyTransfer.create({
      data: {
        vendorId: w.vendor.id, fromEmployeeId: newRow.id, fromCompanyId: w.companyB, toCompanyId: w.companyA, toBranchId: w.orgA.branch.id,
        fromCode: newRow.code, toCode: `${newRow.code}-R`, requestedEffectiveDate: TODAY, effectiveDate: TODAY, status: "PENDING",
      } as any,
    })
    await decideCompanyTransfer(back.id, w.owner.id, w.vendor.id, "APPROVED")
    const third = (await db.companyTransfer.findUniqueOrThrow({ where: { id: back.id } })).toEmployeeId!
    expect(await employmentChainIds(w.vendor.id, third)).toEqual([emp.id, newRow.id, third])
    expect((await db.employee.findUniqueOrThrow({ where: { id: third } })).serviceStartDate).toBe("2023-03-01")
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).companyId).toBe(w.companyA)
  })
})

describe("who sees what afterwards", () => {
  let w: World
  let oldId: string
  let newId: string

  beforeAll(async () => {
    w = await world()
    const emp = await mkStaff(w)
    await db.attendance.create({ data: { vendorId: w.vendor.id, employeeId: emp.id, date: addDays(TODAY, -2), status: "PRESENT", source: "BIOMETRIC" } })
    const r = await transfer(w, emp)
    oldId = r.oldRow.id
    newId = r.newRow.id
  })

  const ids = (r: any) => (r.body.data.items ?? r.body.data).map((e: any) => e.id)

  test("the source company still has the old record and its attendance; not the new one", async () => {
    const list = await postHrm("employees.list", {}, { bearer: w.tokenA })
    expect(ids(list)).toContain(oldId)
    expect(ids(list)).not.toContain(newId)
    expect((await postHrm("employees.get", { id: newId }, { bearer: w.tokenA })).status).toBe(404)
    const profile = await postHrm("employees.get", { id: oldId }, { bearer: w.tokenA })
    expect(profile.status).toBe(200)
    expect(profile.body.data.companyTransfers).toHaveLength(1)
  })

  test("the destination company has the new record; not the old one", async () => {
    const list = await postHrm("employees.list", {}, { bearer: w.tokenB })
    expect(ids(list)).toContain(newId)
    expect(ids(list)).not.toContain(oldId)
    expect((await postHrm("employees.get", { id: oldId }, { bearer: w.tokenB })).status).toBe(404)
    const profile = await postHrm("employees.get", { id: newId }, { bearer: w.tokenB })
    expect(profile.body.data.companyTransfers[0].fromCompanyName).toBeTruthy()
  })

  test("the closed record is read-only and can't re-enter the workforce", async () => {
    expect((await postHrm("employees.update", { id: oldId, fullName: "Changed" }, { bearer: w.tokenA })).status).toBe(409)
    expect((await postHrm("employees.suspend", { id: oldId, reason: "x" }, { bearer: w.tokenA })).status).toBe(400)
    expect((await postHrm("employees.activate", { id: oldId }, { bearer: w.tokenA })).status).not.toBe(200)
    expect((await postHrm("employees.terminate", { employeeId: oldId, reason: "x", exitDate: TODAY }, { bearer: w.tokenA })).status).toBe(409)
    expect((await postHrm("employees.hardDelete", { id: oldId, confirm: (await db.employee.findUniqueOrThrow({ where: { id: oldId } })).code }, { bearer: w.tokenA })).status).toBe(409)
  })

  test("no module can add new records to the closed employment", async () => {
    const refused = "read-only"
    const loan = await postHrm("loans.create", { employeeId: oldId, principal: 5000, installments: 5, startDate: TODAY }, { bearer: w.tokenA })
    expect(loan.status).toBe(409)
    expect(loan.body.error).toContain(refused)
    expect((await postHrm("advances.create", { employeeId: oldId, amount: 500, reason: "x" }, { bearer: w.tokenA })).status).toBe(409)
    expect((await postHrm("expenses.create", { employeeId: oldId, amount: 500, category: "TRAVEL", title: "x", date: TODAY }, { bearer: w.tokenA })).status).toBe(409)
    expect((await postHrm("bonuses.create", { employeeId: oldId, amount: 500 }, { bearer: w.tokenA })).status).toBe(409)
    expect(await db.loan.count({ where: { employeeId: oldId } })).toBe(0)
    expect(await db.advance.count({ where: { employeeId: oldId } })).toBe(0)
    // the live record is unaffected by the guard
    const live = await postHrm("loans.create", { employeeId: newId, principal: 5000, installments: 5, startDate: TODAY }, { bearer: w.tokenB })
    expect(live.body.error ?? "").not.toContain(refused)
  })

  test("attendance can still be corrected for days before the transfer, not after", async () => {
    const before = await postHrm("attendance.mark", { employeeId: oldId, date: addDays(TODAY, -2), status: "PRESENT" }, { bearer: w.tokenA })
    expect(before.body.error ?? "").not.toContain("read-only")
    const after = await postHrm("attendance.mark", { employeeId: oldId, date: TODAY, status: "PRESENT" }, { bearer: w.tokenA })
    expect(after.status).toBe(409)
  })

  test("reports stop counting the closed record as active staff, and don't call it an exit", async () => {
    const year = TODAY.slice(0, 4)
    const month = Number(TODAY.slice(5, 7))
    const r = await postHrm("reports.attritionRate", { year: Number(year), month }, { bearer: w.tokenA })
    expect(r.status).toBe(200)
    // columns: Month, Headcount (start), Headcount (end), Avg Headcount, Exits, Rate
    const row = r.body.data.rows[month - 1]
    expect(row[2]).toBe(0) // the only employee here left on the transfer date
    expect(row[4]).toBe(0)
  })

  test("the person counts as one seat across the tenant", async () => {
    const usage = await usageSnapshot(w.vendor.id)
    const live = await db.employee.count({ where: { vendorId: w.vendor.id, status: { notIn: ["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE", "TRANSFERRED"] } } })
    expect(usage.employees).toBe(live)
    expect(await db.employee.count({ where: { id: { in: [oldId, newId] }, status: "ACTIVE" } })).toBe(1)
  })

  test("today's attendance grid lists them only in the destination", async () => {
    const a = await postHrm("attendance.today", {}, { bearer: w.tokenA })
    expect(JSON.stringify(a.body.data)).not.toContain(oldId)
    const b = await postHrm("attendance.today", {}, { bearer: w.tokenB })
    expect(JSON.stringify(b.body.data)).toContain(newId)
  })
})

describe("the login moves with the person", () => {
  test("an employee login resolves the new company, new record and all their payslips", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const user = await mkUser(w.vendor.id, { role: "EMPLOYEE", employeeId: emp.id })
    const run = await db.payrollRun.create({ data: { vendorId: w.vendor.id, companyId: w.companyA, periodMonth: 2, periodYear: 2025, status: "PAID" } as any })
    const entry = await db.payrollEntry.create({ data: { vendorId: w.vendor.id, runId: run.id, employeeId: emp.id, status: "INCLUDED", gross: 52000, net: 50000, payslipNumber: uniq("PS"), breakdownJson: "{}" } })
    const token = await mkSession(user.id)

    const { newRow } = await transfer(w, emp)
    const moved = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(moved.employeeId).toBe(newRow.id)
    expect(moved.branchId).toBe(w.orgB.branch.id)
    expect(await db.userCompanyAccess.count({ where: { userId: user.id, companyId: w.companyA, active: true } })).toBe(0)
    expect(await db.userCompanyAccess.count({ where: { userId: user.id, companyId: w.companyB, active: true, isDefault: true } })).toBe(1)

    const { getCtxFromToken } = await import("@/hrm-server/auth")
    const ctx = await getCtxFromToken(token)
    expect(ctx?.activeCompanyId).toBe(w.companyB)
    expect(ctx?.employeeId).toBe(newRow.id)

    const pay = await postHrm("ess.payroll", {}, { bearer: token })
    expect(JSON.stringify(pay.body.data)).toContain(entry.id)
  })

  test("someone else's payslip stays out of reach", async () => {
    const w = await world()
    const mine = await mkStaff(w)
    const other = await mkStaff(w)
    const user = await mkUser(w.vendor.id, { role: "EMPLOYEE", employeeId: mine.id })
    const run = await db.payrollRun.create({ data: { vendorId: w.vendor.id, companyId: w.companyA, periodMonth: 3, periodYear: 2025, status: "PAID" } as any })
    const theirs = await db.payrollEntry.create({ data: { vendorId: w.vendor.id, runId: run.id, employeeId: other.id, status: "INCLUDED", gross: 1, net: 1, payslipNumber: uniq("PS"), breakdownJson: "{}" } })
    await transfer(w, mine)
    expect((await postHrm("ess.payroll.html", { entryId: theirs.id }, { bearer: await mkSession(user.id) })).status).toBe(404)
  })

  test("an administrator keeps access to the source company", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const admin = await mkUser(w.vendor.id, { role: "HR_ADMIN", employeeId: emp.id })
    await transfer(w, emp)
    expect(await db.userCompanyAccess.count({ where: { userId: admin.id, companyId: w.companyA, active: true } })).toBe(1)
  })
})

describe("payroll across the transfer", () => {
  // July 2026, Friday off: 26 working days. Transfer on the 16th (13 + 13 working days).
  const E = "2026-07-16"
  const isFriday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5
  const days = Array.from({ length: 31 }, (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`)

  /** Force a past date: scheduling normally moves it forward, this suite needs July. */
  async function scenarioAt() {
    const w = await world()
    const emp = await mkStaff(w)
    await db.attendance.createMany({ data: days.filter((d) => d < E && !isFriday(d)).map((date) => ({ vendorId: w.vendor.id, employeeId: emp.id, date, status: "PRESENT" })) })
    const t = await request(w, emp, { effectiveDate: E, requestedEffectiveDate: E, status: "SCHEDULED" })
    expect((await applyCompanyTransfer(t.id, w.vendor.id, w.owner.id)).applied).toBe(true)
    const newId = (await db.companyTransfer.findUniqueOrThrow({ where: { id: t.id } })).toEmployeeId!
    await db.attendance.createMany({ data: days.filter((d) => d >= E && !isFriday(d)).map((date) => ({ vendorId: w.vendor.id, employeeId: newId, date, status: "PRESENT" })) })
    const run = (companyId: string) => db.payrollRun.create({ data: { vendorId: w.vendor.id, companyId, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: w.owner.id } as any })
    const ctx = (companyId: string): any => ({ userId: w.owner.id, userName: "Owner", vendorId: w.vendor.id, role: "VENDOR_OWNER", permissions: new Set(["*"]), activeCompanyId: companyId, ip: "127.0.0.1" })
    return { w, oldId: emp.id, newId, runA: await run(w.companyA), runB: await run(w.companyB), ctx }
  }

  test("each company pays only its own days, and together they make one month", async () => {
    const s = await scenarioAt()
    await calculateRun(s.ctx(s.w.companyA), s.runA.id)
    await calculateRun(s.ctx(s.w.companyB), s.runB.id)
    const a = await db.payrollEntry.findMany({ where: { runId: s.runA.id } })
    const b = await db.payrollEntry.findMany({ where: { runId: s.runB.id } })
    expect(a.map((e) => e.employeeId)).toEqual([s.oldId])
    expect(b.map((e) => e.employeeId)).toEqual([s.newId])
    expect(a[0].gross).toBe(26000) // 13/26 × 52,000
    expect(b[0].gross).toBe(26000)
    expect(a[0].gross + b[0].gross).toBe(52000)
    expect(a[0].absentDays).toBe(0) // days after the transfer are not absences
    expect(b[0].absentDays).toBe(0) // nor days before it
  })

  test("a later period: only the destination pays", async () => {
    const s = await scenarioAt()
    const aug = (companyId: string) => db.payrollRun.create({ data: { vendorId: s.w.vendor.id, companyId, periodMonth: 8, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: s.w.owner.id } as any })
    const [ra, rb] = [await aug(s.w.companyA), await aug(s.w.companyB)]
    await calculateRun(s.ctx(s.w.companyA), ra.id)
    await calculateRun(s.ctx(s.w.companyB), rb.id)
    expect(await db.payrollEntry.count({ where: { runId: ra.id } })).toBe(0)
    expect((await db.payrollEntry.findMany({ where: { runId: rb.id } })).map((e) => e.employeeId)).toEqual([s.newId])
  })

  test("an earlier period recalculated in the source still pays the full month there", async () => {
    const s = await scenarioAt()
    const june = await db.payrollRun.create({ data: { vendorId: s.w.vendor.id, companyId: s.w.companyA, periodMonth: 6, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: s.w.owner.id } as any })
    const juneRun = await db.payrollRun.create({ data: { vendorId: s.w.vendor.id, companyId: s.w.companyB, periodMonth: 6, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: s.w.owner.id } as any })
    await calculateRun(s.ctx(s.w.companyA), june.id)
    await calculateRun(s.ctx(s.w.companyB), juneRun.id)
    expect((await db.payrollEntry.findFirstOrThrow({ where: { runId: june.id } })).gross).toBe(52000)
    expect(await db.payrollEntry.count({ where: { runId: juneRun.id } })).toBe(0) // not employed there yet
  })

  test("tax withheld by the source company counts towards the destination's year-to-date", async () => {
    const s = await scenarioAt()
    const paid = await db.payrollRun.create({ data: { vendorId: s.w.vendor.id, companyId: s.w.companyA, periodMonth: 7, periodYear: 2026, periodWeek: 1, frequency: "WEEKLY", runType: "REGULAR", status: "PAID" } as any })
    await db.payrollEntry.create({ data: { vendorId: s.w.vendor.id, runId: paid.id, employeeId: s.oldId, status: "INCLUDED", gross: 26000, net: 20000, ait: 999999, payslipNumber: uniq("PS"), breakdownJson: "{}" } })
    const sep = await db.payrollRun.create({ data: { vendorId: s.w.vendor.id, companyId: s.w.companyB, periodMonth: 9, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: s.w.owner.id } as any })
    await calculateRun(s.ctx(s.w.companyB), sep.id)
    const entry = await db.payrollEntry.findFirstOrThrow({ where: { runId: sep.id } })
    expect(entry.employeeId).toBe(s.newId)
    expect(entry.ait).toBe(0) // the year's liability is already covered by the earlier employment
  })
})

describe("leave", () => {
  test("unused days carry to the same-coded type; the source balance stays as history", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const code = uniq("AL")
    const typeA = await db.leaveType.create({ data: { vendorId: w.vendor.id, companyId: w.companyA, code, name: "Annual", paid: true, defaultDays: 20 } as any })
    const typeB = await db.leaveType.create({ data: { vendorId: w.vendor.id, companyId: w.companyB, code, name: "Annual", paid: true, defaultDays: 18 } as any })
    const { leaveYearOf } = await import("@/hrm-server/leave-math")
    const year = leaveYearOf(TODAY, 6)
    const bal = await db.leaveBalance.create({ data: { vendorId: w.vendor.id, employeeId: emp.id, leaveTypeId: typeA.id, year, entitled: 20, used: 5, pending: 0, carriedForward: 2 } })
    const { newRow } = await transfer(w, emp)
    expect((await db.leaveBalance.findFirstOrThrow({ where: { employeeId: newRow.id, leaveTypeId: typeB.id, year } })).entitled).toBe(17)
    const old = await db.leaveBalance.findUniqueOrThrow({ where: { id: bal.id } })
    expect(old.entitled).toBe(20)
    expect(old.used).toBe(5)
  })

  test("turning carry off starts clean, and an unmatched type is reported", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const typeA = await db.leaveType.create({ data: { vendorId: w.vendor.id, companyId: w.companyA, code: uniq("ONLYA"), name: "Only A", paid: true, defaultDays: 5 } as any })
    const { leaveYearOf } = await import("@/hrm-server/leave-math")
    await db.leaveBalance.create({ data: { vendorId: w.vendor.id, employeeId: emp.id, leaveTypeId: typeA.id, year: leaveYearOf(TODAY, 6), entitled: 5, used: 0, pending: 0, carriedForward: 0 } })
    const reported = await transfer(w, emp)
    expect(JSON.parse(reported.t.resultJson).leaveNotes[0]).toContain("Only A")

    const emp2 = await mkStaff(w)
    await db.leaveBalance.create({ data: { vendorId: w.vendor.id, employeeId: emp2.id, leaveTypeId: typeA.id, year: leaveYearOf(TODAY, 6), entitled: 5, used: 0, pending: 0, carriedForward: 0 } })
    const off = await transfer(w, emp2, { carryLeaveBalances: false })
    expect(await db.leaveBalance.count({ where: { employeeId: off.newRow.id } })).toBe(0)
    expect(JSON.parse(off.t.resultJson).leaveNotes).toEqual([])
  })
})

describe("what must be settled first", () => {
  let w: World
  beforeAll(async () => { w = await world() })

  const cases: [string, (e: { id: string }) => Promise<unknown>, string][] = [
    ["open loan", (e) => db.loan.create({ data: { vendorId: w.vendor.id, employeeId: e.id, principal: 100, outstanding: 100, status: "ACTIVE", startDate: "2025-01-01" } as any }), "open loan"],
    ["open advance", (e) => db.advance.create({ data: { vendorId: w.vendor.id, employeeId: e.id, amount: 100, outstanding: 100, status: "RECOVERING", reason: "x", requestDate: "2025-01-01" } as any }), "open advance"],
    ["pending correction", (e) => db.attendanceCorrection.create({ data: { vendorId: w.vendor.id, employeeId: e.id, date: TODAY, reason: "x", status: "PENDING" } as any }), "attendance correction"],
    ["open exit", (e) => db.resignation.create({ data: { vendorId: w.vendor.id, employeeId: e.id, submissionDate: TODAY, resignationDate: TODAY, proposedLwd: TODAY, reason: "x", status: "SUBMITTED" } as any }), "exit case"],
    ["direct report", (e) => db.employee.create({ data: { vendorId: w.vendor.id, companyId: w.companyA, fullName: "Report", code: uniq("R"), joiningDate: "2024-01-01", status: "ACTIVE", reportingManagerId: e.id } as any }), "report to this person"],
  ]
  for (const [label, arrange, expected] of cases) {
    test(`${label} blocks the transfer`, async () => {
      const emp = await mkStaff(w)
      await arrange(emp)
      expect((await transferBlockers(w.vendor.id, emp.id, w.companyA, TODAY)).join(" ")).toContain(expected)
    })
  }

  test("a month the source already paid in full blocks it", async () => {
    const x = await world()
    const emp = await mkStaff(x)
    await db.payrollRun.create({ data: { vendorId: x.vendor.id, companyId: x.companyA, periodMonth: Number(TODAY.slice(5, 7)), periodYear: Number(TODAY.slice(0, 4)), periodWeek: 0, status: "PAID" } as any })
    expect((await transferBlockers(x.vendor.id, emp.id, x.companyA, TODAY)).join(" ")).toContain("already PAID")
  })

  test("a blocker appearing after approval holds the transfer and says why; the retry completes it", async () => {
    const emp = await mkStaff(w)
    const t = await request(w, emp, { status: "SCHEDULED" })
    const loan = await db.loan.create({ data: { vendorId: w.vendor.id, employeeId: emp.id, principal: 100, outstanding: 100, status: "ACTIVE", startDate: "2025-01-01" } as any })
    const held = await applyCompanyTransfer(t.id, w.vendor.id, w.owner.id)
    expect(held.applied).toBe(false)
    const row = await db.companyTransfer.findUniqueOrThrow({ where: { id: t.id } })
    expect(row.status).toBe("SCHEDULED")
    expect(row.applyError).toContain("open loan")
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).status).toBe("ACTIVE") // nothing half-done

    await db.loan.update({ where: { id: loan.id }, data: { status: "CLOSED", outstanding: 0 } })
    const retry = await postHrm("companyTransfer.retry", { id: t.id }, { bearer: w.tokenA })
    expect(retry.status).toBe(200)
    expect(retry.body.data.applied).toBe(true)
  })
})

describe("scheduling", () => {
  test("a future transfer changes nothing until its date, then the daily job applies it", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const future = addDays(TODAY, 10)
    const t = await request(w, emp, { effectiveDate: future, requestedEffectiveDate: future })
    await decideCompanyTransfer(t.id, w.owner.id, w.vendor.id, "APPROVED")
    expect((await db.companyTransfer.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("SCHEDULED")
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).status).toBe("ACTIVE")

    expect(await applyDueCompanyTransfers(w.vendor.id, TODAY)).toBe(0)
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).companyId).toBe(w.companyA)
    expect(await applyDueCompanyTransfers(w.vendor.id, future)).toBe(1)
    const after = await db.employee.findUniqueOrThrow({ where: { id: emp.id } })
    expect(after.status).toBe("TRANSFERRED")
    expect(after.transferredOutDate).toBe(future)
  })

  test("an approval after the requested date applies from today, and keeps what was asked for", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const past = addDays(TODAY, -5)
    const { t } = await transfer(w, emp, { effectiveDate: past, requestedEffectiveDate: past })
    expect(t.effectiveDate).toBe(TODAY)
    expect(t.requestedEffectiveDate).toBe(past)
  })

  test("rejection changes nothing", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const t = await request(w, emp)
    await decideCompanyTransfer(t.id, w.owner.id, w.vendor.id, "REJECTED")
    expect((await db.companyTransfer.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("REJECTED")
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).status).toBe("ACTIVE")
    expect(await db.employee.count({ where: { priorEmployeeId: emp.id } })).toBe(0)
  })

  test("a scheduled transfer can be cancelled; a completed one cannot", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const future = addDays(TODAY, 3)
    const t = await request(w, emp, { effectiveDate: future, requestedEffectiveDate: future, status: "SCHEDULED" })
    expect((await postHrm("companyTransfer.cancel", { id: t.id }, { bearer: w.tokenA })).status).toBe(200)
    expect(await applyDueCompanyTransfers(w.vendor.id, future)).toBe(0)

    const done = await transfer(w, await mkStaff(w))
    expect((await postHrm("companyTransfer.cancel", { id: done.t.id }, { bearer: w.tokenA })).status).toBe(409)
  })
})

describe("the request route", () => {
  let w: World
  let hrToken: string

  beforeAll(async () => {
    w = await world()
    const wf = await db.approvalWorkflow.create({ data: { vendorId: w.vendor.id, companyId: w.companyA, processType: "TRANSFER", name: uniq("Transfer"), active: true } })
    await db.approvalStep.create({ data: { vendorId: w.vendor.id, workflowId: wf.id, sequence: 1, name: "Owner", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL" } as any })
    const hr = await mkUser(w.vendor.id, { role: "HR_ADMIN", permissions: ["*"] })
    hrToken = await mkSession(hr.id)
  })

  const body = (emp: { id: string }, over: Record<string, unknown> = {}) => ({ employeeId: emp.id, toCompanyId: w.companyB, toBranchId: w.orgB.branch.id, effectiveDate: TODAY, reason: "Restructuring", ...over })

  test("the full path: request → approval → transferred", async () => {
    const emp = await mkStaff(w)
    const res = await postHrm("companyTransfer.request", body(emp, { toDepartmentId: w.orgB.department.id }), { bearer: hrToken })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe("PENDING")
    expect(res.body.data.requestedByName).toBeTruthy()
    const approval = await db.approvalRequest.findFirstOrThrow({ where: { vendorId: w.vendor.id, entityType: "CompanyTransfer", entityId: res.body.data.id } })
    expect(approval.companyId).toBe(w.companyA)
    const act = await postHrm("approvals.act", { requestId: approval.id, decision: "APPROVE" }, { bearer: w.tokenA })
    expect(act.status).toBe(200)
    const t = await db.companyTransfer.findUniqueOrThrow({ where: { id: res.body.data.id } })
    expect(t.status).toBe("COMPLETED")
    expect((await db.employee.findUniqueOrThrow({ where: { id: t.toEmployeeId! } })).companyId).toBe(w.companyB)
    const list = await postHrm("companyTransfer.list", {}, { bearer: w.tokenB })
    const row = list.body.data.find((r: any) => r.id === t.id)
    expect(row.toCompanyName).toBe("Company B")
    expect(row.sourceSnapshotJson).toBeUndefined() // contact details stay out of lists
  })

  test("refused: wrong-company branch, same company, past date, blockers, code clash, second request", async () => {
    const emp = await mkStaff(w)
    expect((await postHrm("companyTransfer.request", body(emp, { toBranchId: w.orgA.branch.id }), { bearer: hrToken })).status).toBe(400)
    expect((await postHrm("companyTransfer.request", body(emp, { toCompanyId: w.companyA, toBranchId: w.orgA.branch.id }), { bearer: hrToken })).status).toBe(400)
    expect((await postHrm("companyTransfer.request", body(emp, { effectiveDate: addDays(TODAY, -1) }), { bearer: hrToken })).status).toBe(400)

    const clash = await db.employee.create({ data: { vendorId: w.vendor.id, companyId: w.companyB, fullName: "Clash", code: emp.code, joiningDate: "2024-01-01", status: "ACTIVE" } as any })
    expect((await postHrm("companyTransfer.request", body(emp), { bearer: hrToken })).status).toBe(409)
    const ok = await postHrm("companyTransfer.request", body(emp, { toCode: `${emp.code}-B` }), { bearer: hrToken })
    expect(ok.status).toBe(200)
    expect(clash.id).toBeTruthy()
    expect((await postHrm("companyTransfer.request", body(emp, { toCode: `${emp.code}-C` }), { bearer: hrToken })).status).toBe(409)

    const owing = await mkStaff(w)
    await db.loan.create({ data: { vendorId: w.vendor.id, employeeId: owing.id, principal: 100, outstanding: 100, status: "ACTIVE", startDate: "2025-01-01" } as any })
    const blocked = await postHrm("companyTransfer.request", body(owing), { bearer: hrToken })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toContain("loan")
  })

  test("security: no access to the destination, or another tenant's records, or no permission", async () => {
    const emp = await mkStaff(w)
    const manager = await mkUser(w.vendor.id, { role: "HR_MANAGER", permissions: ["employees.edit", "employees.view"] })
    const res = await postHrm("companyTransfer.request", body(emp), { bearer: await mkSession(manager.id) })
    expect(res.status).toBe(403)
    expect((await postHrm("companyTransfer.destinationOptions", { companyId: w.companyB }, { bearer: await mkSession(manager.id) })).status).toBe(403)

    const other = await world()
    expect((await postHrm("companyTransfer.request", body(emp), { bearer: other.tokenA })).status).toBe(404)
    expect((await postHrm("companyTransfer.destinationOptions", { companyId: w.companyB }, { bearer: other.tokenA })).status).toBe(404)
    const foreign = await mkStaff(other)
    expect((await postHrm("companyTransfer.request", body(foreign, { toCompanyId: w.companyB }), { bearer: other.tokenA })).status).toBe(404)

    const clerk = await mkUser(w.vendor.id, { role: "EMPLOYEE", permissions: [] })
    expect((await postHrm("companyTransfer.request", body(emp), { bearer: await mkSession(clerk.id) })).status).toBe(403)
  })

  test("the source company's users can't withdraw or see a transfer of another pair", async () => {
    const x = await world()
    const empX = await mkStaff(x)
    const t = await request(x, empX)
    expect((await postHrm("companyTransfer.cancel", { id: t.id }, { bearer: w.tokenA })).status).toBe(404)
    const seen = await postHrm("companyTransfer.list", {}, { bearer: w.tokenA })
    expect(JSON.stringify(seen.body.data)).not.toContain(t.id)
  })

  test("destination options list only that company's org", async () => {
    const o = await postHrm("companyTransfer.destinationOptions", { companyId: w.companyB }, { bearer: hrToken })
    expect(o.status).toBe(200)
    expect(o.body.data.branches.map((b: any) => b.id)).toEqual([w.orgB.branch.id])
    expect(o.body.data.shifts.map((s: any) => s.id)).toEqual([w.orgB.shift.id])
  })
})

describe("attendance devices", () => {
  test("the old device mapping ends, so a stray punch can't land on a closed record", async () => {
    const w = await world()
    const emp = await mkStaff(w)
    const device = await db.attendanceDevice.create({ data: { vendorId: w.vendor.id, companyId: w.companyA, deviceId: uniq("D"), name: "Gate", manufacturer: "ZKTeco", protocol: "ADMS", deviceIdentifier: uniq("SN"), serialNumber: uniq("SN"), timezone: "Asia/Dhaka", enabled: true, status: "OFFLINE" } as any })
    await db.attendanceDeviceUser.create({ data: { vendorId: w.vendor.id, deviceId: device.id, deviceUserId: "7", employeeId: emp.id, enrollmentStatus: "ACTIVE" } as any })
    await transfer(w, emp)
    expect(await db.attendanceDeviceUser.count({ where: { employeeId: emp.id, enrollmentStatus: "ACTIVE" } })).toBe(0)
  })
})

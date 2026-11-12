/// <reference types="bun-types" />
// ============ FORENSIC AUDIT 2026-11-10 — PHASE 1 regression suite ============
// Cross-company data-plane isolation (FIN-005/006/007/008/009/010/024) and
// money-math defects (FIN-011/012), driven the same way the audit verified
// them: through the REAL dispatcher (postHrm → POST /api/hrm) where a session
// exists, and against the engine functions directly where the audit pinned
// them (zkteco/processor). Fixture shape mirrors multi-company-remediation:
// ONE vendor, Company A (default) + Company B, employees in each.
import "./_testdb"
import { today } from "@/hrm-server/utils"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import {
  findEmployeeForDeviceUser,
  autoMapDeviceUser,
  mapDeviceUser,
  mapAndProcessEvent,
  invalidateEmployeeDirectoryCache,
} from "@/hrm-server/zkteco/processor"

// ---------------------------------------------------------------------------
// fixtures — one vendor, Company A (default) + Company B
// ---------------------------------------------------------------------------
let vendor: any, cA: any, cB: any
let brA: any, brB: any, dpB: any, desB: any
let empA: any, empA2: any, empB: any
let devA: any, devB: any
let tA: string, tB: string, tAll: string, tEssA: string
let whA1: any, whA2: any, itemA: any

const todayIso = () => new Date().toISOString().slice(0, 10)
const ok = (r: { status: number; body: any }) => r.status === 200 && r.body?.ok === true

beforeAll(async () => {
  vendor = await mkVendor(uniq("P1 Vendor"), { company: false })
  cA = await db.company.create({ data: { vendorId: vendor.id, code: uniq("CA"), name: "P1 Company A", active: true, isDefault: true } })
  cB = await db.company.create({ data: { vendorId: vendor.id, code: uniq("CB"), name: "P1 Company B", active: true } })
  brA = await db.branch.create({ data: { vendorId: vendor.id, companyId: cA.id, code: uniq("BA"), name: "P1 Branch A" } })
  brB = await db.branch.create({ data: { vendorId: vendor.id, companyId: cB.id, code: uniq("BB"), name: "P1 Branch B" } })
  dpB = await db.department.create({ data: { vendorId: vendor.id, companyId: cB.id, code: uniq("DB"), name: "P1 Dept B" } })
  desB = await db.designation.create({ data: { vendorId: vendor.id, companyId: cB.id, code: uniq("DSB"), name: "P1 Desig B" } })

  const mkEmp = async (name: string, companyId: string, code: string) =>
    db.employee.create({
      data: {
        vendorId: vendor.id, code, fullName: name, companyId,
        joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE",
      },
    })
  // SAME numeric tail (7777) in both companies: the classic cross-company
  // collision the vendor-wide resolver used to win by insertion order. The
  // "-7777" suffix (after uniq's alphanumeric noise) makes the numeric tail
  // EXACTLY 7777 for both.
  empA = await mkEmp("P1 A Emp Seven", cA.id, `${uniq("P1A")}-7777`)
  empA2 = await mkEmp("P1 A Colleague", cA.id, uniq("P1A2"))
  empB = await mkEmp("P1 B Emp Seven", cB.id, `${uniq("P1B")}-7777`)
  // birthdays in the CURRENT month so calendar BIRTHDAY events fire
  const mm = String(new Date().getMonth() + 1).padStart(2, "0")
  await db.employee.update({ where: { id: empA.id }, data: { dob: `1990-${mm}-05`, branchId: brA.id } })
  await db.employee.update({ where: { id: empB.id }, data: { dob: `1991-${mm}-06` } })

  const mkDev = async (companyId: string, name: string) =>
    db.attendanceDevice.create({
      data: {
        companyId, vendorId: vendor.id, deviceId: uniq("D"), name,
        deviceIdentifier: uniq("SN"), protocol: "ADMS", enabled: true,
        timezone: "Asia/Dhaka", status: "ONLINE", syncStatus: "IDLE", eventCount: 0, configuration: "{}",
      },
    })
  devA = await mkDev(cA.id, "P1 Device A")
  devB = await mkDev(cB.id, "P1 Device B")

  const mkAdmin = async (companyId: string, name: string) => {
    const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: uniq(name), permissions: ["*"] })
    await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: u.id, companyId, role: "HR_ADMIN", active: true, isDefault: companyId === cA.id } })
    const s = await mkSession(u.id)
    await db.session.update({ where: { id: s }, data: { activeCompanyId: companyId } })
    return s
  }
  tA = await mkAdmin(cA.id, "P1AdminA")
  tB = await mkAdmin(cB.id, "P1AdminB")
  const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: uniq("P1Owner"), permissions: ["*", "companies.consolidated"] })
  await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: owner.id, companyId: cA.id, role: "VENDOR_OWNER", active: true, isDefault: true } })
  await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: owner.id, companyId: cB.id, role: "VENDOR_OWNER", active: true } })
  tAll = await mkSession(owner.id)
  await db.session.update({ where: { id: tAll }, data: { activeCompanyId: null, allCompaniesMode: true } })

  // ESS user whose employment is in Company A
  const essUser = await mkUser(vendor.id, { role: "EMPLOYEE", name: uniq("P1EssA"), employeeId: empA.id })
  tEssA = await mkSession(essUser.id)

  // FIN-010 — enable a (fake) email gateway BEFORE any route call so the
  // cached settings tree already carries it when communications.send reaches
  // its configuration gate (getSettings caches per vendor for the TTL).
  for (const [key, value] of [["enabled", true], ["host", "smtp.test.local"], ["username", "p1"], ["password", "p1"]] as const) {
    await db.hrSetting.create({ data: { vendorId: vendor.id, group: "email", key, value: JSON.stringify(value) } })
  }
})

// ---------------------------------------------------------------------------
// FIN-005 + FIN-024 — device→employee resolution is bounded by the DEVICE's company
// ---------------------------------------------------------------------------
describe("FIN-005/024 — ZKTeco resolution company boundary", () => {
  test("EXACT rule: a Company B device context cannot resolve a Company A employee by code", async () => {
    // Company A employee's code, resolved under Company B's bound → nothing
    const miss = await findEmployeeForDeviceUser(vendor.id, empA.code, undefined, { companyId: cB.id })
    expect(miss).toBeNull()
    // under Company A's own bound → resolves
    const hit = await findEmployeeForDeviceUser(vendor.id, empA.code.toLowerCase(), undefined, { companyId: cA.id })
    expect(hit?.id).toBe(empA.id)
    expect(hit?.rule).toBe("EXACT")
  })

  test("NUMERIC rule: PIN with the same numeric tail resolves per-company, not by insertion order", async () => {
    invalidateEmployeeDirectoryCache()
    // both companies carry a code with numeric tail 7777 → vendor-wide legacy call is ambiguous
    expect(await findEmployeeForDeviceUser(vendor.id, "7777")).toBeNull()
    // company-bounded calls each resolve their OWN employee
    const inA = await findEmployeeForDeviceUser(vendor.id, "7777", undefined, { companyId: cA.id })
    expect(inA?.id).toBe(empA.id)
    expect(inA?.rule).toBe("NUMERIC")
    const inB = await findEmployeeForDeviceUser(vendor.id, "7777", undefined, { companyId: cB.id })
    expect(inB?.id).toBe(empB.id)
    expect(inB?.rule).toBe("NUMERIC")
  })

  test("FIN-024 — the directory cache is sliced per company (no cross-company cache bleed)", async () => {
    invalidateEmployeeDirectoryCache()
    // prime company A's slice…
    const a = await findEmployeeForDeviceUser(vendor.id, "7777", undefined, { companyId: cA.id })
    expect(a?.id).toBe(empA.id)
    // …a Company B resolution right after must NOT be served A's rows
    const b = await findEmployeeForDeviceUser(vendor.id, "7777", undefined, { companyId: cB.id })
    expect(b?.id).toBe(empB.id)
    // vendor-granular invalidation still drops every slice of the vendor
    invalidateEmployeeDirectoryCache(vendor.id)
    const b2 = await findEmployeeForDeviceUser(vendor.id, "7777", undefined, { companyId: cB.id })
    expect(b2?.id).toBe(empB.id)
  })

  test("autoMapDeviceUser never creates a cross-company mapping (EXACT code on the other company's device)", async () => {
    // Company B device sees a PIN equal to Company A employee's code
    const m = await autoMapDeviceUser(vendor.id, devB.id, empA.code)
    expect(m).toBeNull()
    expect(await db.attendanceDeviceUser.count({ where: { deviceId: devB.id } })).toBe(0)
    // the SAME device maps its own company's employee fine
    const m2 = await autoMapDeviceUser(vendor.id, devB.id, empB.code)
    expect(m2?.employeeId).toBe(empB.id)
  })

  test("manual mapDeviceUser refuses a cross-company mapping with a clean 400", async () => {
    // Company A device + Company B employee (device company is set on both sides)
    let err: any = null
    try {
      await mapDeviceUser(
        { userId: "test-admin", userName: "P1 Test Admin", vendorId: vendor.id },
        { deviceId: devA.id, deviceUserId: "4242", employeeId: empB.id },
      )
    } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(String(err?.message)).toMatch(/different company/i)
    expect(err?.code).toBe(400)
    expect(await db.attendanceDeviceUser.count({ where: { deviceId: devA.id, employeeId: empB.id } })).toBe(0)
  })

  test("a PRE-EXISTING cross-company mapping (created before the fix) no longer processes punches", async () => {
    // hand-insert the exact row the old unbounded auto-mapper could have made
    const mapping = await db.attendanceDeviceUser.create({
      data: { vendorId: vendor.id, deviceId: devB.id, employeeId: empA.id, deviceUserId: "9999", enrollmentStatus: "ACTIVE" },
    })
    expect(mapping.employeeId).toBe(empA.id)
    const ev = await db.attendanceRawEvent.create({
      data: {
        vendorId: vendor.id, deviceId: devB.id, deviceSerial: devB.deviceIdentifier, deviceUserId: "9999",
        eventTime: `${todayIso()} 09:05:00`, verifyMode: 1, attendanceStatus: null, workCode: null,
        eventType: "CHECK_IN", rawLine: "l", payloadHash: uniq("p1-cc"), processingStatus: "RECEIVED",
      },
    })
    const res = await mapAndProcessEvent(ev as any)
    expect(res).toBe("FAILED")
    const after = await db.attendanceRawEvent.findUnique({ where: { id: ev.id } })
    expect(after?.processingError).toMatch(/different company/i)
    // and no attendance row was built for the cross-company employee
    expect(await db.attendance.count({ where: { vendorId: vendor.id, employeeId: empA.id, date: todayIso() } })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// FIN-006 — employees.update org anchors validated against the employee's company
// ---------------------------------------------------------------------------
describe("FIN-006 — employees.update company-anchored org validation", () => {
  test("injecting Company B's branch/department/designation into a Company A employee is refused", async () => {
    for (const patch of [
      { branchId: brB.id },
      { departmentId: dpB.id },
      { designationId: desB.id },
    ]) {
      const r = await postHrm("employees.update", { id: empA.id, fullName: empA.fullName, ...patch }, { bearer: tA })
      expect(r.body?.ok).toBe(false)
      expect(r.body?.code).toBe(400)
      expect(String(r.body?.error)).toMatch(/different company/)
    }
  })

  test("a Company B manager cannot be injected as a Company A employee's reporting manager", async () => {
    const r = await postHrm("employees.update", { id: empA.id, fullName: empA.fullName, reportingManagerId: empB.id }, { bearer: tA })
    expect(r.body?.ok).toBe(false)
    expect(r.body?.code).toBe(400)
    expect(String(r.body?.error)).toMatch(/different company/)
  })

  test("same-company anchors still save (no false positives)", async () => {
    const r = await postHrm("employees.update", { id: empA.id, fullName: empA.fullName, branchId: brA.id }, { bearer: tA })
    expect(ok(r)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FIN-007 — dashboard.stats "attendance today" counts only the active company
// ---------------------------------------------------------------------------
describe("FIN-007 — dashboard.stats attendance-today company block", () => {
  test("a Company A viewer counts only Company A's attendance rows; All Companies sees both", async () => {
    // FIN-007 (Phase 3 follow-up): the fixture date must use the APP's
    // today() (Asia/Dhaka zoned, utils.ts zonedParts) — the old UTC
    // toISOString() diverges from the route's `today()` between 18:00-24:00
    // UTC (after Dhaka midnight), making the widget count 0 rows.
    await db.attendance.createMany({
      data: [
        { vendorId: vendor.id, employeeId: empA.id, date: today(), status: "PRESENT" },
        { vendorId: vendor.id, employeeId: empB.id, date: today(), status: "PRESENT" },
      ],
    })
    const rA = await postHrm("dashboard.stats", {}, { bearer: tA })
    expect(ok(rA)).toBe(true)
    expect(rA.body.data.attendanceToday.present).toBe(1)
    const rAll = await postHrm("dashboard.stats", {}, { bearer: tAll })
    expect(ok(rAll)).toBe(true)
    expect(rAll.body.data.attendanceToday.present).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// FIN-008 — calendar.events company context
// ---------------------------------------------------------------------------
describe("FIN-008 — calendar.events company-bounded feed", () => {
  const month = new Date().getMonth() + 1
  const year = new Date().getFullYear()

  test("each company's viewer sees only that company's birthdays (the All-Companies surface is dispatcher-blocked for calendar)", async () => {
    const rA = await postHrm("calendar.events", { month, year }, { bearer: tA })
    expect(ok(rA)).toBe(true)
    const names = (rA.body.data as any[]).filter((e) => e.kind === "BIRTHDAY").map((e) => e.title)
    expect(names.some((t) => t.includes(empA.fullName))).toBe(true)
    expect(names.some((t) => t.includes(empB.fullName))).toBe(false)
    // and symmetrically for Company B's viewer
    const rB = await postHrm("calendar.events", { month, year }, { bearer: tB })
    expect(ok(rB)).toBe(true)
    const namesB = (rB.body.data as any[]).filter((e) => e.kind === "BIRTHDAY").map((e) => e.title)
    expect(namesB.some((t) => t.includes(empB.fullName))).toBe(true)
    expect(namesB.some((t) => t.includes(empA.fullName))).toBe(false)
    // the consolidated surface itself is refused by the central dispatcher
    const rAll = await postHrm("calendar.events", { month, year }, { bearer: tAll })
    expect(rAll.status).toBe(403)
  })

  test("another company's task never leaks into the feed (not even with a placeholder name)", async () => {
    await db.task.create({
      data: {
        vendorId: vendor.id, companyId: cB.id, title: uniq("P1SECRETBNRTASK"),
        assigneeId: empB.id, scope: "EMPLOYEE", priority: "HIGH",
        dueDate: todayIso(), status: "TODO", progress: 10,
      },
    })
    const rA = await postHrm("calendar.events", { month, year }, { bearer: tA })
    expect(ok(rA)).toBe(true)
    const tasks = (rA.body.data as any[]).filter((e) => e.kind === "TASK")
    expect(tasks.length).toBe(0)
    const rB = await postHrm("calendar.events", { month, year }, { bearer: tB })
    const tasksB = (rB.body.data as any[]).filter((e) => e.kind === "TASK")
    expect(tasksB.length).toBe(1)
    expect(tasksB[0].title).toContain("P1SECRETBNRTASK")
  })
})

// ---------------------------------------------------------------------------
// FIN-009 — ess.colleagues bounded by the self employee's company
// ---------------------------------------------------------------------------
describe("FIN-009 — ess.colleagues company-bounded directory", () => {
  test("an ESS user in Company A sees only Company A colleagues", async () => {
    const r = await postHrm("ess.colleagues", {}, { bearer: tEssA })
    expect(ok(r)).toBe(true)
    const list = r.body.data as any[]
    const ids = list.map((e) => e.id)
    expect(ids).toContain(empA2.id)
    expect(ids).not.toContain(empB.id)
  })
})

// ---------------------------------------------------------------------------
// FIN-010 — communications.send recipient pool bounded by the active company
// ---------------------------------------------------------------------------
describe("FIN-010 — communications.send company-bounded audience", () => {
  test("audienceType=ALL from Company A resolves ONLY Company A staff", async () => {
    const r = await postHrm("communications.send", { channel: "EMAIL", subject: uniq("P1 blast"), message: "p1 test", audienceType: "ALL" }, { bearer: tA })
    expect(ok(r)).toBe(true)
    // Company A has exactly two ACTIVE employees (empA, empA2)
    expect(r.body.data.recipientCount).toBe(2)
    const log = await db.communicationLog.findFirstOrThrow({ where: { vendorId: vendor.id }, orderBy: { createdAt: "desc" } })
    expect(log.recipientCount).toBe(2)
  })

  test("SPECIFIC ids from Company B are ignored — the blast stays inside the sender's company", async () => {
    const r = await postHrm("communications.send", { channel: "EMAIL", subject: uniq("P1 smuggle"), message: "p1 test", audienceType: "SPECIFIC", audienceIds: [empB.id, empA.id] }, { bearer: tA })
    expect(ok(r)).toBe(true)
    expect(r.body.data.recipientCount).toBe(1) // only empA; empB silently out of pool
  })

  test("All Companies mode cannot send (read-only consolidated view → 403)", async () => {
    const r = await postHrm("communications.send", { channel: "EMAIL", subject: uniq("P1 all"), message: "p1 test", audienceType: "ALL" }, { bearer: tAll })
    expect(r.status).toBe(403)
    expect(String(r.body?.error)).toMatch(/All Companies mode is a read-only/i)
  })
})

// ---------------------------------------------------------------------------
// FIN-011 — PF import WITHDRAWAL rows are stored negative (ledger direction)
// ---------------------------------------------------------------------------
describe("FIN-011 — PF import WITHDRAWAL negation (golden fixture)", () => {
  test("imported withdrawals land as NEGATIVE ledger movements and the balance DROPS", async () => {
    const row = (source: string, employeeAmount: number, employerAmount: number, month: number, note?: string) => ({
      "Employee Code": empA.code,
      "Employee Name": empA.fullName,
      "Employee Contribution (BDT)": employeeAmount,
      "Employer Contribution (BDT)": employerAmount,
      "Source (OPENING / MANUAL)": source,
      Year: 2026,
      Month: month,
      ...(note ? { Note: note } : {}),
    })
    const r = await postHrm("pf.import.execute", {
      rows: [
        row("OPENING", 50000, 50000, 1, uniq("P1 opening")),
        row("WITHDRAWAL", 20000, 0, 2, uniq("P1 exit settlement")),
      ],
    }, { bearer: tA })
    expect(ok(r)).toBe(true)
    expect(r.body.data.importedCount).toBe(2)

    const rows = await db.pfContribution.findMany({
      where: { vendorId: vendor.id, employeeId: empA.id },
      orderBy: { periodMonth: "asc" },
    })
    expect(rows.length).toBe(2)
    // OPENING keeps its positive direction…
    expect(rows[0].source).toBe("OPENING")
    expect(rows[0].employeeAmount).toBe(50000)
    expect(rows[0].employerAmount).toBe(50000)
    // …and the WITHDRAWAL is stored NEGATIVE — the manual path's ledger rule
    // (the old importer stored +20000, inflating the exit settlement)
    expect(rows[1].source).toBe("WITHDRAWAL")
    expect(rows[1].employeeAmount).toBe(-20000)
    expect(rows[1].employerAmount).toBe(0)

    // balance math: the sum of movements drops by the withdrawn amount
    const net = rows.reduce((s, x) => s + x.employeeAmount + x.employerAmount, 0)
    expect(net).toBe(80000) // 100000 opening − 20000 withdrawal

    // the exit-criterion view: same balance the PF statement would compute
    const balance = await db.pfContribution.aggregate({
      where: { vendorId: vendor.id, employeeId: empA.id },
      _sum: { employeeAmount: true, employerAmount: true },
    })
    expect((balance._sum.employeeAmount || 0) + (balance._sum.employerAmount || 0)).toBe(80000)
  })
})

// ---------------------------------------------------------------------------
// FIN-012 — inventory transfer TOCTOU: concurrent double-spend is impossible
// ---------------------------------------------------------------------------
describe("FIN-012 — inventory transfer conditional decrement", () => {
  beforeAll(async () => {
    itemA = await db.item.create({
      data: { vendorId: vendor.id, companyId: cA.id, code: uniq("ITM"), name: "P1 Widget", unit: "pcs" },
    })
    whA1 = await db.warehouse.create({ data: { vendorId: vendor.id, companyId: cA.id, name: uniq("P1 WH1") } })
    whA2 = await db.warehouse.create({ data: { vendorId: vendor.id, companyId: cA.id, name: uniq("P1 WH2") } })
  })

  test("two concurrent transfers of 8 from a stock of 10: exactly ONE succeeds, quantity never goes negative", async () => {
    await db.stockLevel.create({ data: { vendorId: vendor.id, itemId: itemA.id, warehouseId: whA1.id, quantity: 10, reserved: 0 } })

    const send = () => postHrm("inventory.stock.transfer", { itemId: itemA.id, fromWarehouseId: whA1.id, toWarehouseId: whA2.id, quantity: 8 }, { bearer: tA })
    const results = await Promise.allSettled([send(), send()])
    const bodies = results.map((x) => (x.status === "fulfilled" ? x.value : null)).filter(Boolean) as any[]
    const successes = bodies.filter((b) => b.status === 200 && b.body?.ok === true)
    expect(successes.length).toBe(1)

    const level = await db.stockLevel.findUniqueOrThrow({ where: { itemId_warehouseId: { itemId: itemA.id, warehouseId: whA1.id } } })
    expect(level.quantity).toBe(2)
    expect(level.quantity).toBeGreaterThanOrEqual(0)

    // exactly one TRANSFER_OUT ledger row was written for the double-spend pair
    const outs = await db.stockTransaction.count({ where: { vendorId: vendor.id, itemId: itemA.id, warehouseId: whA1.id, kind: "TRANSFER_OUT" } })
    expect(outs).toBe(1)
  })

  test("a sequential overspend is still refused with the availability message", async () => {
    const r = await postHrm("inventory.stock.transfer", { itemId: itemA.id, fromWarehouseId: whA1.id, toWarehouseId: whA2.id, quantity: 8 }, { bearer: tA })
    expect(r.body?.ok).toBe(false)
    // the route's availability Deny carries the default code (403) — asserted
    // here as the pre-existing contract; the message is the stable part
    expect(String(r.body?.error)).toMatch(/Insufficient available stock/i)
    const level = await db.stockLevel.findUniqueOrThrow({ where: { itemId_warehouseId: { itemId: itemA.id, warehouseId: whA1.id } } })
    expect(level.quantity).toBe(2)
  })
})

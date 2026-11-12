/// <reference types="bun-types" />
// ============ Full-audit remediation regression suite (2026-11-05 audit) ============
// One regression test per fixed finding. Each drives the real dispatcher where
// the finding was about a route, so the guard is proven wired in, not just
// present. Gap ids refer to the audit's master register; NEW-00x were found
// while repairing the test baseline (see docs/AUDIT-REMEDIATION-CHECKLIST.md).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import fs from "fs"
import path from "path"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { rebuildDaily } from "@/hrm-server/zkteco/processor"
import { materializeAbsentDay, approvalReminderSweep } from "@/hrm-server/jobs"
import { isHumanProtectedRow, isSweepAbsentRow, SWEEP_ABSENT_REMARK, ATTENDANCE_SOURCE_SYSTEM } from "@/hrm-server/attendance-source"
import { calculateRun, payRun } from "@/hrm-server/payroll"
import { hashPassword, hashPasswordAsync, verifyPasswordAsync, verifyPassword, passwordNeedsRehash, login, invalidateVendorActive, sessionTokenHash, newToken } from "@/hrm-server/auth"
import { getSettings, saveSettingsGroup } from "@/hrm-server/settings"
import { sanitizeHtml } from "@/lib/sanitize-html"
import { reportToCsv } from "@/hrm-server/analytics-report"
import { resolveEffectivePolicy } from "@/hrm-server/attendance-policy"
import { calculateAit, ensureAitConfig, loadAitConfig } from "@/hrm-server/ait-engine"
import { GET as verifyLetter } from "@/app/api/verify/letter/route"
import { today, addDays } from "@/hrm-server/utils"
import crypto from "crypto"

const ok = (r: { status: number }) => expect(r.status).toBe(200)

/** A tenant with two companies and a user on each side of the boundary. */
async function twoCompanyTenant(role = "HR_ADMIN") {
  const vendor = await mkVendor(uniq("Audit MC"))
  const companyA = (await defaultCompanyId(vendor.id))!
  const companyB = (await db.company.create({ data: { vendorId: vendor.id, code: uniq("B"), name: "Company B", active: true } })).id
  const userA = await mkUser(vendor.id, { role })
  const userB = await db.user.create({
    data: { name: "B user", email: `${uniq("ub")}@test.local`, passwordHash: "x", role, permissions: JSON.stringify(["*"]), vendorId: vendor.id },
  })
  await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: userB.id, companyId: companyB, role, active: true, isDefault: true } })
  const tokenA = await mkSession(userA.id)
  const tokenB = await mkSession(userB.id)
  return { vendor, companyA, companyB, userA, userB, tokenA, tokenB }
}

// ---------------------------------------------------------------------------
describe("GAP-103 / GAP-209 — who wins a device rebuild", () => {
  const DAY = "2026-10-06" // a Tuesday, outside any paid period of this vendor
  let vendor: { id: string }
  let device: { id: string; deviceId: string }

  const punch = (employeeId: string, date: string, clock: string) => db.attendanceRawEvent.create({
    data: {
      vendorId: vendor.id, deviceId: device.id, deviceSerial: device.deviceId, deviceUserId: "1", employeeId,
      eventTime: `${date} ${clock}`, eventType: "AUTO", rawLine: `1\t${date} ${clock}`, payloadHash: uniq("ph"), processingStatus: "RECEIVED",
    } as any,
  })

  beforeAll(async () => {
    vendor = await mkVendor(uniq("Audit Attendance"))
    device = await db.attendanceDevice.create({
      data: { companyId: await defaultCompanyId(vendor.id), vendorId: vendor.id, deviceId: uniq("D"), name: "Gate", manufacturer: "ZKTeco", protocol: "ADMS", deviceIdentifier: uniq("SN"), serialNumber: uniq("SN"), timezone: "Asia/Dhaka", enabled: true, status: "OFFLINE" } as any,
    }) as any
  })

  test("the sweep stamps SYSTEM, and a late punch rebuilds the day", async () => {
    const emp = await mkEmployee(vendor.id)
    await materializeAbsentDay(vendor.id, DAY, await getSettings(vendor.id))
    const swept = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date: DAY } })
    expect(swept?.status).toBe("ABSENT")
    expect(swept?.source).toBe(ATTENDANCE_SOURCE_SYSTEM)

    await punch(emp.id, DAY, "09:05:00")
    await punch(emp.id, DAY, "17:30:00")
    const res = await rebuildDaily(vendor.id, emp.id, DAY)
    expect(res.protected).toBe(false)
    const rebuilt = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date: DAY } })
    expect(rebuilt?.status).not.toBe("ABSENT")
    expect(rebuilt?.checkIn).toBe("09:05")
    expect(rebuilt?.source).toBe("BIOMETRIC")
    const raw = await db.attendanceRawEvent.findMany({ where: { employeeId: emp.id } })
    expect(raw.every((r) => r.processingStatus === "PROCESSED")).toBe(true)
  })

  test("sweep rows written before the fix (source MANUAL) rebuild too", async () => {
    const emp = await mkEmployee(vendor.id)
    await db.attendance.create({ data: { vendorId: vendor.id, employeeId: emp.id, date: DAY, status: "ABSENT", source: "MANUAL", remarks: SWEEP_ABSENT_REMARK } })
    await punch(emp.id, DAY, "09:00:00")
    await punch(emp.id, DAY, "17:00:00")
    expect((await rebuildDaily(vendor.id, emp.id, DAY)).protected).toBe(false)
    expect((await db.attendance.findFirst({ where: { employeeId: emp.id, date: DAY } }))?.checkIn).toBe("09:00")
  })

  test("a lone OUT on a swept day leaves it ABSENT rather than inventing a check-in", async () => {
    const emp = await mkEmployee(vendor.id)
    await db.attendance.create({ data: { vendorId: vendor.id, employeeId: emp.id, date: DAY, status: "ABSENT", source: ATTENDANCE_SOURCE_SYSTEM, remarks: SWEEP_ABSENT_REMARK } })
    await db.attendanceRawEvent.create({
      data: { vendorId: vendor.id, deviceId: device.id, deviceSerial: device.deviceId, deviceUserId: "1", employeeId: emp.id, eventTime: `${DAY} 18:00:00`, eventType: "OUT", rawLine: "x", payloadHash: uniq("ph"), processingStatus: "RECEIVED" } as any,
    })
    await rebuildDaily(vendor.id, emp.id, DAY)
    const row = await db.attendance.findFirst({ where: { employeeId: emp.id, date: DAY } })
    expect(row?.status).toBe("ABSENT")
    expect(row?.checkIn).toBeNull()
  })

  test("a human ABSENT mark stays protected", async () => {
    const emp = await mkEmployee(vendor.id)
    await db.attendance.create({ data: { vendorId: vendor.id, employeeId: emp.id, date: DAY, status: "ABSENT", source: "MANUAL", remarks: "No show, confirmed by manager" } })
    await punch(emp.id, DAY, "09:00:00")
    expect((await rebuildDaily(vendor.id, emp.id, DAY)).protected).toBe(true)
    const raw = await db.attendanceRawEvent.findFirst({ where: { employeeId: emp.id } })
    expect(raw?.processingStatus).toBe("SKIPPED_MANUAL")
  })

  test("an approved correction survives a later rebuild, through the real route", async () => {
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const token = await mkSession(owner.id)
    const emp = await mkEmployee(vendor.id)
    const date = addDays(today(), -1)
    await punch(emp.id, date, "10:30:00")
    await punch(emp.id, date, "17:00:00")
    await rebuildDaily(vendor.id, emp.id, date)
    const req = await postHrm("attendance.corrections.request", { employeeId: emp.id, date, requestedIn: "09:00", requestedOut: "17:00", reason: "Device clock was wrong" }, { bearer: token })
    ok(req)
    ok(await postHrm("attendance.corrections.act", { id: req.body.data.id, decision: "APPROVED" }, { bearer: token }))
    expect((await db.attendance.findFirst({ where: { employeeId: emp.id, date } }))?.checkIn).toBe("09:00")

    await punch(emp.id, date, "10:31:00") // late history sync
    expect((await rebuildDaily(vendor.id, emp.id, date)).protected).toBe(true)
    const after = await db.attendance.findFirst({ where: { employeeId: emp.id, date } })
    expect(after?.checkIn).toBe("09:00")
    expect(after?.source).toBe("BIOMETRIC") // provenance is still preserved
  })

  test("provenance rules, table-driven", () => {
    expect(isSweepAbsentRow({ source: "SYSTEM", status: "ABSENT" })).toBe(true)
    expect(isSweepAbsentRow({ source: "SYSTEM", status: "PRESENT" })).toBe(false)
    expect(isHumanProtectedRow({ source: "MANUAL", status: "LATE", remarks: null })).toBe(true)
    expect(isHumanProtectedRow({ source: "BIOMETRIC", status: "LATE", remarks: "ADMS push (auto-computed)" })).toBe(false)
    expect(isHumanProtectedRow({ source: "BIOMETRIC", status: "LATE", remarks: "Manually corrected (biometric record preserved)" })).toBe(true)
    expect(isHumanProtectedRow({ source: "SYSTEM", status: "ABSENT", remarks: SWEEP_ABSENT_REMARK })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-322 — one open correction per employee-day", () => {
  test("a second pending request is refused; after a decision a new one is allowed", async () => {
    const vendor = await mkVendor(uniq("Audit Corr"))
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const token = await mkSession(owner.id)
    const emp = await mkEmployee(vendor.id)
    const date = addDays(today(), -1)
    const payload = { employeeId: emp.id, date, requestedIn: "09:00", requestedOut: "17:00", reason: "Forgot to punch" }
    const first = await postHrm("attendance.corrections.request", payload, { bearer: token })
    ok(first)
    expect((await postHrm("attendance.corrections.request", payload, { bearer: token })).status).toBe(409)
    ok(await postHrm("attendance.corrections.act", { id: first.body.data.id, decision: "REJECTED" }, { bearer: token }))
    ok(await postHrm("attendance.corrections.request", payload, { bearer: token }))
  })
})

// ---------------------------------------------------------------------------
describe("GAP-201 — letters.download respects the company boundary", () => {
  test("cross-company letter id is a 404, own company still works", async () => {
    const t = await twoCompanyTenant()
    const empB = await db.employee.create({ data: { vendorId: t.vendor.id, companyId: t.companyB, fullName: "B Emp", code: uniq("E"), joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" } })
    const letter = await db.hrLetter.create({
      data: { vendorId: t.vendor.id, employeeId: empB.id, type: "EXPERIENCE", letterNumber: uniq("L"), subject: "s", content: "<p>Gross 90000</p>", status: "ISSUED" } as any,
    })
    expect((await postHrm("letters.download", { id: letter.id, reason: "audit" }, { bearer: t.tokenA })).status).toBe(404)
    ok(await postHrm("letters.download", { id: letter.id, reason: "audit" }, { bearer: t.tokenB }))
  })
})

// ---------------------------------------------------------------------------
describe("GAP-210 — shift CRUD is company-scoped", () => {
  test("stamped on create; another company's shift is invisible and unmodifiable; unstamped legacy rows stay manageable", async () => {
    const t = await twoCompanyTenant()
    const created = await postHrm("shifts.create", { name: "A morning", startTime: "09:00", endTime: "17:00" }, { bearer: t.tokenA })
    ok(created)
    expect(created.body.data.companyId).toBe(t.companyA)
    const legacy = await db.shift.create({ data: { vendorId: t.vendor.id, companyId: null, name: "Legacy", startTime: "08:00", endTime: "16:00" } as any })

    const listB = await postHrm("shifts.list", {}, { bearer: t.tokenB })
    const idsB = listB.body.data.map((s: any) => s.id)
    expect(idsB).not.toContain(created.body.data.id)
    expect(idsB).toContain(legacy.id)

    expect((await postHrm("shifts.update", { id: created.body.data.id, name: "hijack" }, { bearer: t.tokenB })).status).toBe(404)
    expect((await postHrm("shifts.delete", { id: created.body.data.id }, { bearer: t.tokenB })).status).toBe(404)
    ok(await postHrm("shifts.update", { id: legacy.id, name: "Legacy renamed" }, { bearer: t.tokenB }))
  })

  test("GAP-334 — an overlapping roster is allowed but reported", async () => {
    const vendor = await mkVendor(uniq("Audit Roster"))
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const token = await mkSession(owner.id)
    const emp = await mkEmployee(vendor.id)
    const shift = await postHrm("shifts.create", { name: "Day", startTime: "09:00", endTime: "17:00" }, { bearer: token })
    const first = await postHrm("rosters.assign", { employeeId: emp.id, shiftId: shift.body.data.id, fromDate: "2026-11-01", toDate: "2026-11-30" }, { bearer: token })
    ok(first)
    expect(first.body.data.overlaps).toHaveLength(0)
    const second = await postHrm("rosters.assign", { employeeId: emp.id, shiftId: shift.body.data.id, fromDate: "2026-11-15", toDate: "2026-12-15" }, { bearer: token })
    ok(second)
    expect(second.body.data.overlaps).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-211 — recompute targets the ledger's fiscal year", () => {
  test("a July-FY tenant recomputes the leave year apply charges, not the calendar year", async () => {
    const vendor = await mkVendor(uniq("Audit FY"))
    await saveSettingsGroup(vendor.id, "general", { fiscalYearStart: "July" })
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const token = await mkSession(owner.id)
    const emp = await mkEmployee(vendor.id)
    const type = await db.leaveType.create({ data: { vendorId: vendor.id, companyId: await defaultCompanyId(vendor.id), code: uniq("L"), name: "Annual", paid: true, defaultDays: 12 } as any })
    ok(await postHrm("leaveBalances.recompute", {}, { bearer: token }))
    const { leaveYearOf } = await import("@/hrm-server/leave-math")
    const expected = leaveYearOf(today(), 6)
    const row = await db.leaveBalance.findFirst({ where: { employeeId: emp.id, leaveTypeId: type.id } })
    expect(row?.year).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-212 — suspending a tenant ends live access", () => {
  async function liveTenant() {
    const vendor = await mkVendor(uniq("Audit Suspend"))
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    return { vendor, token: await mkSession(owner.id) }
  }

  test("session traffic is refused while inactive and resumes on reactivation", async () => {
    const { vendor, token } = await liveTenant()
    ok(await postHrm("employees.list", {}, { bearer: token }))
    await db.vendor.update({ where: { id: vendor.id }, data: { active: false } })
    invalidateVendorActive(vendor.id)
    expect((await postHrm("employees.list", {}, { bearer: token })).status).toBe(401)
    await db.vendor.update({ where: { id: vendor.id }, data: { active: true } })
    invalidateVendorActive(vendor.id)
    ok(await postHrm("employees.list", {}, { bearer: token }))
  })

  test("the v1 API key path is refused too", async () => {
    const { vendor } = await liveTenant()
    const raw = `fk_${crypto.randomBytes(24).toString("hex")}`
    await db.apiKey.create({
      data: { vendorId: vendor.id, name: "k", prefix: raw.slice(0, 12), hash: crypto.createHash("sha256").update(raw, "utf8").digest("hex"), scopesJson: JSON.stringify(["attendance:read"]) } as any,
    })
    const { authenticateApiKey } = await import("@/app/api/v1/_auth")
    const req = () => new NextRequest("http://localhost/api/v1/attendance", { headers: { authorization: `Bearer ${raw}` } })
    expect((await authenticateApiKey(req(), "attendance:read")).ok).toBe(true)
    await db.vendor.update({ where: { id: vendor.id }, data: { active: false } })
    invalidateVendorActive(vendor.id)
    const denied = await authenticateApiKey(req(), "attendance:read")
    expect(denied.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe("NEW-001 / GAP-215 — the settings write matrix", () => {
  test("a single-company admin can save tenant-wide groups (the Company Profile form was unsavable)", async () => {
    const vendor = await mkVendor(uniq("Audit Single"))
    const hr = await mkUser(vendor.id, { role: "HR_ADMIN", permissions: ["*"] })
    const token = await mkSession(hr.id)
    ok(await postHrm("settings.save", { group: "general", values: { phone: "+8801700000000" } }, { bearer: token }))
    ok(await postHrm("settings.patch", { group: "email", values: { fromName: "HR" } }, { bearer: token }))
    expect((await getSettings(vendor.id)).general.phone).toBe("+8801700000000")
  })

  test("in a multi-company tenant the owner can, a company admin cannot", async () => {
    const t = await twoCompanyTenant("HR_ADMIN")
    const owner = await mkUser(t.vendor.id, { role: "VENDOR_OWNER" })
    const ownerToken = await mkSession(owner.id)
    ok(await postHrm("settings.save", { group: "email", values: { fromName: "Group HR" } }, { bearer: ownerToken }))
    const denied = await postHrm("settings.save", { group: "email", values: { fromName: "Hijack" } }, { bearer: t.tokenA })
    expect(denied.status).toBe(400)
    expect(String(denied.body.error)).toContain("tenant owner")
    expect((await getSettings(t.vendor.id)).email.fromName).toBe("Group HR")
  })

  test("the three dedicated routes obey the same matrix for a company admin", async () => {
    const t = await twoCompanyTenant("HR_ADMIN")
    expect((await postHrm("messageTemplates.save", { key: "birthday_wish", emailBody: "Hi {name}" }, { bearer: t.tokenA })).status).toBe(400)
    expect((await postHrm("ai.settings.save", { enabled: true }, { bearer: t.tokenA })).status).toBe(400)
    expect((await postHrm("bonuses.savePolicy", { minServiceMonths: 3 }, { bearer: t.tokenA })).status).toBe(400)
  })

  test("the same routes work for a single-company tenant", async () => {
    const vendor = await mkVendor(uniq("Audit Single2"))
    const hr = await mkUser(vendor.id, { role: "HR_ADMIN", permissions: ["*"] })
    const token = await mkSession(hr.id)
    ok(await postHrm("messageTemplates.save", { key: "birthday_wish", emailBody: "Hi {name}" }, { bearer: token }))
    ok(await postHrm("ai.settings.save", { enabled: false }, { bearer: token }))
    ok(await postHrm("bonuses.savePolicy", { minServiceMonths: 3 }, { bearer: token }))
  })
})

// ---------------------------------------------------------------------------
describe("GAP-202 — ATS rows inherit the company of their opening", () => {
  let t: Awaited<ReturnType<typeof twoCompanyTenant>>
  let appB: { id: string }
  let interview: { id: string }
  let offer: { id: string }
  let task: { id: string }

  beforeAll(async () => {
    t = await twoCompanyTenant()
    const openingB = await db.jobOpening.create({ data: { vendorId: t.vendor.id, companyId: t.companyB, title: "B role", status: "OPEN" } as any })
    appB = await db.jobApplication.create({ data: { vendorId: t.vendor.id, openingId: openingB.id, name: "Secret Candidate", email: "secret@test.local", source: "MANUAL", status: "SHORTLISTED" } as any })
    interview = await db.jobInterview.create({ data: { vendorId: t.vendor.id, applicationId: appB.id, round: "R1", mode: "ONSITE", scheduledAt: "2026-12-01T10:00:00" } as any })
    offer = await db.offerLetter.create({ data: { vendorId: t.vendor.id, applicationId: appB.id, title: "Offer", basicSalary: 90000, status: "DRAFT" } as any })
    task = await db.onboardingTask.create({ data: { vendorId: t.vendor.id, applicationId: appB.id, title: "Docs" } as any })
  })

  test("lists from another company do not show the row; the owning company does", async () => {
    for (const [action, id] of [["ats.interviews.list", interview.id], ["ats.offers.list", offer.id], ["ats.onboarding.list", task.id]] as const) {
      const a = await postHrm(action, {}, { bearer: t.tokenA })
      ok(a)
      expect(a.body.data.map((r: any) => r.id)).not.toContain(id)
      const b = await postHrm(action, {}, { bearer: t.tokenB })
      expect(b.body.data.map((r: any) => r.id)).toContain(id)
    }
    const apps = await postHrm("recruitment.applications.list", {}, { bearer: t.tokenA })
    expect(apps.body.data.map((r: any) => r.id)).not.toContain(appB.id)
  })

  test("every by-id action from another company is a 404", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["ats.interviews.save", { applicationId: appB.id, round: "R2", mode: "PHONE", scheduledAt: "2026-12-02T10:00" }],
      ["ats.interviews.save", { id: interview.id, applicationId: appB.id, round: "R2", mode: "PHONE", scheduledAt: "2026-12-02T10:00" }],
      ["ats.interviews.outcome", { id: interview.id, outcome: "PASSED" }],
      ["ats.offers.save", { applicationId: appB.id, title: "Rogue offer" }],
      ["ats.offers.send", { id: offer.id }],
      ["ats.offers.decide", { id: offer.id, decision: "ACCEPTED" }],
      ["ats.offers.letter", { id: offer.id }],
      ["ats.onboarding.save", { applicationId: appB.id, title: "Rogue" }],
      ["ats.onboarding.toggle", { id: task.id }],
      ["ats.onboarding.delete", { id: task.id }],
      ["recruitment.applications.status", { id: appB.id, status: "REJECTED" }],
      ["recruitment.applications.cv", { id: appB.id }],
    ]
    for (const [action, payload] of calls) {
      expect([action, (await postHrm(action, payload, { bearer: t.tokenA })).status]).toEqual([action, 404])
    }
    expect((await db.jobApplication.findUnique({ where: { id: appB.id } }))?.status).toBe("SHORTLISTED")
    expect((await db.offerLetter.findUnique({ where: { id: offer.id } }))?.status).toBe("DRAFT")
  })

  test("the owning company keeps working", async () => {
    ok(await postHrm("ats.offers.letter", { id: offer.id }, { bearer: t.tokenB }))
    ok(await postHrm("ats.interviews.outcome", { id: interview.id, outcome: "PASSED" }, { bearer: t.tokenB }))
  })
})

// ---------------------------------------------------------------------------
describe("GAP-203 — cameras are company-scoped", () => {
  test("stamped on create, invisible and unlaunchable from another company", async () => {
    const t = await twoCompanyTenant()
    const created = await postHrm("camera.create", { brand: "EZVIZ", name: "A lobby", serialNumber: uniq("SN") }, { bearer: t.tokenA })
    ok(created)
    const id = created.body.data.id ?? created.body.data.camera?.id
    expect((await db.camera.findUnique({ where: { id } }))?.companyId).toBe(t.companyA)

    const listB = await postHrm("camera.list", {}, { bearer: t.tokenB })
    ok(listB)
    expect(JSON.stringify(listB.body.data)).not.toContain(id)
    expect((await postHrm("camera.get", { id }, { bearer: t.tokenB })).status).toBe(404)
    expect((await postHrm("camera.launch", { id }, { bearer: t.tokenB })).status).toBe(404)
    expect((await postHrm("camera.delete", { id, confirm: "x" }, { bearer: t.tokenB })).status).not.toBe(200)
  })

  test("an unstamped camera stays visible until M3b backfills it", async () => {
    const t = await twoCompanyTenant()
    const legacy = await db.camera.create({ data: { vendorId: t.vendor.id, companyId: null, brand: "EZVIZ", name: "Old", serialNumber: uniq("SN") } as any })
    expect(JSON.stringify((await postHrm("camera.list", {}, { bearer: t.tokenB })).body.data)).toContain(legacy.id)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-306 — voucher pointers in the approval queue", () => {
  test("another company's voucher does not appear", async () => {
    const t = await twoCompanyTenant()
    const memo = uniq("Secret memo")
    await db.accountJournal.create({
      data: { vendorId: t.vendor.id, companyId: t.companyB, date: "2026-10-01", memo, amount: 5000, status: "PENDING_APPROVAL", linesJson: "[]", refType: "MANUAL" } as any,
    })
    const a = await postHrm("approvals.queue", {}, { bearer: t.tokenA })
    ok(a)
    expect(JSON.stringify(a.body.data)).not.toContain(memo)
    const b = await postHrm("approvals.queue", {}, { bearer: t.tokenB })
    expect(JSON.stringify(b.body.data)).toContain(memo)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-205 — template apply is atomic", () => {
  test("a failure after the supersede leaves the old structure ACTIVE", async () => {
    const vendor = await mkVendor(uniq("Audit Tpl"))
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const token = await mkSession(owner.id)
    const emp = await mkEmployee(vendor.id)
    const current = await db.salaryStructure.create({ data: { vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2024-01-01", basic: 10000, gross: 10000, status: "ACTIVE" } as any })
    const tpl = await db.salaryTemplate.create({ data: { vendorId: vendor.id, companyId: await defaultCompanyId(vendor.id), name: "T", basic: 20000 } as any })

    // force the LAST write of the sequence to fail: the history row points at an
    // employee id the FK refuses when the employee is gone mid-transaction
    const realTx = db.$transaction.bind(db)
    ;(db as any).$transaction = (fn: any, ...rest: any[]) => realTx(async (tx: any) => {
      const proxied = new Proxy(tx, {
        get(t, prop) {
          if (prop === "employeeHistory") return { create: async () => { throw new Error("simulated crash") } }
          return t[prop]
        },
      })
      return fn(proxied)
    }, ...rest)
    try {
      const r = await postHrm("salaryTemplates.apply", { templateId: tpl.id, employeeId: emp.id, effectiveFrom: "2026-10-01" }, { bearer: token })
      expect(r.status).not.toBe(200)
    } finally {
      ;(db as any).$transaction = realTx
    }
    const rows = await db.salaryStructure.findMany({ where: { employeeId: emp.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(current.id)
    expect(rows[0].status).toBe("ACTIVE")
  })
})

// ---------------------------------------------------------------------------
describe("Payroll pay path", () => {
  async function approvedRun(month: number, totals: Record<string, number>) {
    const vendor = await mkVendor(uniq("Audit Pay"))
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const emp = await mkEmployee(vendor.id)
    const run = await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(vendor.id), vendorId: vendor.id, periodMonth: month, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "APPROVED", employeeCount: 1, ...totals } as any,
    })
    return { vendor, owner, emp, run, ctx: makeCtx(owner), token: await mkSession(owner.id) }
  }

  test("GAP-204 — a clamped net no longer makes the run unpayable; the journal balances", async () => {
    // gross 10,000; loan recovery 12,000 → net clamped to 0: credits exceed debits by 2,000
    const { vendor, emp, run, token } = await approvedRun(3, { totalGross: 10000, totalNet: 0 })
    await db.payrollEntry.create({ data: { vendorId: vendor.id, runId: run.id, employeeId: emp.id, status: "INCLUDED", gross: 10000, net: 0, loanDeduction: 12000, breakdownJson: "{}" } })
    const res = await postHrm("payroll.pay", { runId: run.id }, { bearer: token })
    expect(res.status).toBe(200)
    const paid = await db.payrollRun.findUnique({ where: { id: run.id } })
    expect(paid?.status).toBe("PAID")
    const journal = await db.accountJournal.findFirst({ where: { vendorId: vendor.id, refId: run.id } })
    const lines = JSON.parse(journal!.linesJson) as { debit?: number; credit?: number }[]
    const sum = (k: "debit" | "credit") => Math.round(lines.reduce((s, l) => s + (Number(l[k]) || 0), 0) * 100)
    expect(sum("debit")).toBe(sum("credit"))
    expect(sum("debit")).toBe(1200000)
  })

  test("NEW-002 / GAP-316 — a bonus approved after calculation is not marked PAID", async () => {
    const { vendor, emp, run, token } = await approvedRun(4, { totalGross: 10000, totalNet: 10000 })
    await db.payrollEntry.create({
      data: { vendorId: vendor.id, runId: run.id, employeeId: emp.id, status: "INCLUDED", gross: 10000, net: 10000, breakdownJson: JSON.stringify({ bonusLines: [], deductionLines: [] }) },
    })
    const late = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "PERFORMANCE", amount: 5000, status: "APPROVED", periodMonth: 4, periodYear: 2026 } as any })
    ok(await postHrm("payroll.pay", { runId: run.id }, { bearer: token }))
    expect((await db.bonus.findUnique({ where: { id: late.id } }))?.status).toBe("APPROVED")
  })

  test("legacy snapshots with no line list keep the period-wide fallback", async () => {
    const { vendor, emp, run, token } = await approvedRun(5, { totalGross: 10000, totalNet: 10000 })
    await db.payrollEntry.create({ data: { vendorId: vendor.id, runId: run.id, employeeId: emp.id, status: "INCLUDED", gross: 10000, net: 10000, breakdownJson: "{}" } })
    const b = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "PERFORMANCE", amount: 5000, status: "APPROVED", periodMonth: 5, periodYear: 2026 } as any })
    ok(await postHrm("payroll.pay", { runId: run.id }, { bearer: token }))
    expect((await db.bonus.findUnique({ where: { id: b.id } }))?.status).toBe("PAID")
  })

  test("GAP-315 — fractional EMIs credit whole paisa and close cleanly", async () => {
    const { vendor, emp, run, token } = await approvedRun(new Date().getMonth() + 1, { totalGross: 10000, totalNet: 9899.9 })
    await db.payrollRun.update({ where: { id: run.id }, data: { periodYear: new Date().getFullYear() } })
    await db.payrollEntry.create({ data: { vendorId: vendor.id, runId: run.id, employeeId: emp.id, status: "INCLUDED", gross: 10000, net: 9899.9, loanDeduction: 100.1, breakdownJson: "{}" } })
    const now = new Date()
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
    const loan = await db.loan.create({ data: { vendorId: vendor.id, employeeId: emp.id, principal: 100.1, outstanding: 100.1, status: "ACTIVE", startDate: `${prefix}-01` } })
    const a = await db.loanInstallment.create({ data: { vendorId: vendor.id, loanId: loan.id, no: 1, dueDate: `${prefix}-05`, amount: 33.37, status: "PENDING" } })
    const b = await db.loanInstallment.create({ data: { vendorId: vendor.id, loanId: loan.id, no: 2, dueDate: `${prefix}-10`, amount: 33.37, status: "PENDING" } })
    const c = await db.loanInstallment.create({ data: { vendorId: vendor.id, loanId: loan.id, no: 3, dueDate: `${prefix}-15`, amount: 33.36, status: "PENDING" } })
    ok(await postHrm("payroll.pay", { runId: run.id }, { bearer: token }))
    const rows = await db.loanInstallment.findMany({ where: { id: { in: [a.id, b.id, c.id] } } })
    expect(rows.every((r) => r.status === "PAID")).toBe(true)
    for (const r of rows) expect(Math.round(r.paidAmount * 100) / 100).toBe(r.paidAmount)
    const total = rows.reduce((s, r) => s + r.paidAmount, 0)
    expect(Math.round(total * 100)).toBe(10010)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-319 — prorated payslip lines add up to gross", () => {
  test("a mid-month joiner with awkward components: lines equal gross to the paisa", async () => {
    const v = await mkVendor(uniq("Audit Prorate"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const emp = await mkEmployee(v.id)
    await db.employee.update({ where: { id: emp.id }, data: { joiningDate: "2026-07-14" } })
    await db.salaryStructure.create({
      data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 33333, houseRent: 16667, medical: 3333, conveyance: 1667, gross: 55000 },
    })
    const days = Array.from({ length: 31 }, (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`)
    await db.attendance.createMany({
      data: days.filter((d) => d >= "2026-07-14" && new Date(d + "T00:00:00Z").getUTCDay() !== 5).map((d) => ({ vendorId: v.id, employeeId: emp.id, date: d, status: "PRESENT" })),
    })
    const run = await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: u.id },
    })
    await calculateRun(makeCtx(u), run.id)
    const e = await db.payrollEntry.findFirst({ where: { runId: run.id } })
    const bd = JSON.parse(e!.breakdownJson || "{}")
    expect(bd.proration).toBeDefined()
    const sumPaisa = bd.earnings.reduce((t: number, l: any) => t + Math.round(l.amount * 100), 0)
    expect(sumPaisa).toBe(Math.round(e!.gross * 100))
  })
})

// ---------------------------------------------------------------------------
describe("GAP-309 — no account-existence oracle in the public policy hints", () => {
  test("anonymous callers get the same generic policy for any email", async () => {
    const vendor = await mkVendor(uniq("Audit Policy"))
    await saveSettingsGroup(vendor.id, "passwordPolicy", { minLength: 15 })
    const user = await mkUser(vendor.id)
    const known = await postHrm("auth.password.policy", { email: user.email })
    const unknown = await postHrm("auth.password.policy", { email: `${uniq("nobody")}@test.local` })
    expect(known.body.data.policy).toEqual(unknown.body.data.policy)
  })

  test("a signed-in caller gets their tenant's real policy", async () => {
    const vendor = await mkVendor(uniq("Audit Policy2"))
    await saveSettingsGroup(vendor.id, "passwordPolicy", { minLength: 15 })
    const user = await mkUser(vendor.id)
    const r = await postHrm("auth.password.policy", {}, { bearer: await mkSession(user.id) })
    expect(r.body.data.policy.minLength).toBe(15)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-310 — mutating routes leave an audit row", () => {
  const rowFor = (vendorId: string, action: string) => db.auditLog.findFirst({ where: { vendorId, action } })

  test("kpiTemplates.delete and announcements.create", async () => {
    const vendor = await mkVendor(uniq("Audit Trail"))
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const token = await mkSession(owner.id)
    const tpl = await db.kpiTemplate.create({ data: { vendorId: vendor.id, companyId: await defaultCompanyId(vendor.id), name: "T", itemsJson: "[]" } as any })
    ok(await postHrm("kpiTemplates.delete", { id: tpl.id }, { bearer: token }))
    expect(await rowFor(vendor.id, "kpiTemplates.delete")).not.toBeNull()
    ok(await postHrm("announcements.create", { title: "Hello", body: "World", audienceType: "ALL" }, { bearer: token }))
    expect(await rowFor(vendor.id, "announcements.create")).not.toBeNull()
  })

  test("payslips.emailAll", async () => {
    const vendor = await mkVendor(uniq("Audit Trail2"))
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const token = await mkSession(owner.id)
    const run = await db.payrollRun.create({ data: { companyId: await defaultCompanyId(vendor.id), vendorId: vendor.id, periodMonth: 1, periodYear: 2026, status: "PAID" } as any })
    ok(await postHrm("payslips.emailAll", { runId: run.id }, { bearer: token }))
    expect(await rowFor(vendor.id, "payslips.emailAll")).not.toBeNull()
  })

  test("source check for the two routes that need gateways/tickets to exercise", () => {
    const read = (p: string) => fs.readFileSync(path.join(import.meta.dir, "..", "..", p), "utf8")
    expect(read("src/hrm-server/routes/communication.ts")).toContain(`audit(ctx, "communications.send"`)
    expect(read("src/hrm-server/routes/support.ts")).toContain(`audit(ctx, "support.ticket.reopen"`)
    // the audit also listed exit.assets.return: it audits through the shared helper
    expect(read("src/hrm-server/routes/assets.ts")).toContain("await audit(ctx, via, \"Asset\"")
  })
})

// ---------------------------------------------------------------------------
describe("GAP-311 — verification rate bucket ignores a spoofed X-Forwarded-For", () => {
  test("rotating the header does not mint fresh buckets", async () => {
    // FIN-037 follow-up (Phase 2): the test verifies the UNTRUSTED-proxy
    // posture (a raw XFF must be ignored). It used to ride on whatever the
    // ambient environment carried — with the deployment template's
    // HRM_TRUST_PROXY="1" (.env line 120, correct for production behind
    // Caddy) auto-loaded into the test process, the first XFF hop was
    // honored, every rotation minted a fresh bucket and the test failed for
    // the wrong reason. The posture under test is now PINNED here, the same
    // prev/restore pattern phase1-remediation.test.ts uses.
    const prevTrust = process.env.HRM_TRUST_PROXY
    process.env.HRM_TRUST_PROXY = "0"
    let limited = false
    try {
      for (let i = 0; i < 40 && !limited; i++) {
        const res = await verifyLetter(new NextRequest("http://localhost/api/verify/letter?code=ZZZ", { headers: { "x-forwarded-for": `198.51.100.${i}` } }))
        limited = res.status === 429
      }
      expect(limited).toBe(true)
    } finally {
      if (prevTrust === undefined) delete process.env.HRM_TRUST_PROXY
      else process.env.HRM_TRUST_PROXY = prevTrust
    }
  })
})

// ---------------------------------------------------------------------------
describe("GAP-312 — CMS block uses the allowlist sanitizer", () => {
  test("the payloads the old regex let through are removed", () => {
    expect(sanitizeHtml(`<iframe srcdoc="<script>alert(1)</script>"></iframe>x`)).not.toContain("iframe")
    expect(sanitizeHtml(`<meta http-equiv="refresh" content="0;url=https://evil.test">x`)).not.toContain("meta")
    expect(sanitizeHtml(`<a href="javascript:alert(1)">x</a>`)).not.toContain("javascript")
    expect(sanitizeHtml(`<img src=x onerror=alert(1)>`)).not.toContain("onerror")
    expect(sanitizeHtml(`<p class="lead">Hello <a href="https://ok.test">ok</a></p>`)).toContain(`href="https://ok.test"`)
  })

  test("the page block imports it, and the module stays free of server imports", () => {
    const root = path.join(import.meta.dir, "..", "..")
    expect(fs.readFileSync(path.join(root, "src/saas/web/blocks/simple-blocks.tsx"), "utf8")).toContain("__html: sanitizeHtml(html)")
    expect(fs.readFileSync(path.join(root, "src/lib/sanitize-html.ts"), "utf8")).not.toMatch(/^import /m)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-313 — scrypt cost rotation", () => {
  const legacyHash = (pw: string) => {
    const salt = crypto.randomBytes(16).toString("hex")
    return `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`
  }

  test("new hashes carry the cost; both forms verify, sync and async", async () => {
    const fresh = await hashPasswordAsync("Correct-Horse-9")
    expect(fresh.startsWith("n32768:")).toBe(true)
    expect(passwordNeedsRehash(fresh)).toBe(false)
    expect(await verifyPasswordAsync("Correct-Horse-9", fresh)).toBe(true)
    expect(await verifyPasswordAsync("wrong", fresh)).toBe(false)
    expect(verifyPassword("Correct-Horse-9", hashPassword("Correct-Horse-9"))).toBe(true)

    const old = legacyHash("Correct-Horse-9")
    expect(passwordNeedsRehash(old)).toBe(true)
    expect(await verifyPasswordAsync("Correct-Horse-9", old)).toBe(true)
    expect(await verifyPasswordAsync("wrong", old)).toBe(false)
    expect(verifyPassword("Correct-Horse-9", old)).toBe(true)
  })

  test("a successful login upgrades a legacy hash; a failed one does not", async () => {
    const vendor = await mkVendor(uniq("Audit Scrypt"))
    const user = await mkUser(vendor.id)
    const old = legacyHash("Correct-Horse-9")
    await db.user.update({ where: { id: user.id }, data: { passwordHash: old, passwordChangedAt: new Date() } })
    await login(user.email, "wrong-password").catch(() => {})
    expect((await db.user.findUnique({ where: { id: user.id } }))?.passwordHash).toBe(old)
    await login(user.email, "Correct-Horse-9").catch(() => {})
    const stored = (await db.user.findUnique({ where: { id: user.id } }))!.passwordHash
    expect(stored.startsWith("n32768:")).toBe(true)
    expect(await verifyPasswordAsync("Correct-Horse-9", stored)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-317 — over-withholding is stated, not hidden", () => {
  test("a surplus yields the warning and a zero deduction; a normal year does not warn", async () => {
    const vendor = await mkVendor(uniq("Audit AIT"))
    await ensureAitConfig(vendor.id)
    const cfg = await loadAitConfig(vendor.id)
    const input = { monthlyGrossSalary: 100000, annualGrossOverride: 1200000, monthsRemainingInFy: 3 }
    const over = calculateAit(cfg!, { ...input, tdsYtd: 500000 })
    expect(over.monthlyTdsCatchUp).toBe(0) // the floor stays until the refund decision (D-BD-9)
    expect(over.warnings.map((w: any) => w.code)).toContain("TDS_OVER_WITHHELD")
    const normal = calculateAit(cfg!, { ...input, tdsYtd: 0 })
    expect(normal.warnings.map((w: any) => w.code)).not.toContain("TDS_OVER_WITHHELD")
  })
})

// ---------------------------------------------------------------------------
describe("GAP-318 — AIT batch CSV reports skipped rows", () => {
  test("a row with no positive gross produces a warning instead of vanishing", async () => {
    const vendor = await mkVendor(uniq("Audit AIT CSV"))
    await ensureAitConfig(vendor.id)
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const r = await postHrm("ait.batch.calculate", { csvRows: [{ name: "Zero Pay", code: "Z1", gross: 0 }, { name: "Paid", gross: 50000 }] }, { bearer: await mkSession(owner.id) })
    ok(r)
    expect(r.body.data.csvWarnings).toHaveLength(1)
    expect(r.body.data.csvWarnings[0]).toContain("Zero Pay")
    expect(r.body.data.results.map((x: any) => x.name)).toEqual(["Paid"])
  })
})

// ---------------------------------------------------------------------------
describe("GAP-321 — attendance month defaults follow the Dhaka clock", () => {
  test("no server-local month/year default remains in the attendance routes", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src/hrm-server/routes/attendance.ts"), "utf8")
    expect(src).not.toMatch(/p\?\.(month|year) \|\| new Date\(\)/)
    expect(src).toContain("p?.month || Number(today().slice(5, 7))")
  })

  test("the register answers for the current Dhaka month when the caller omits it", async () => {
    const vendor = await mkVendor(uniq("Audit Month"))
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    ok(await postHrm("attendance.register", {}, { bearer: await mkSession(owner.id) }))
  })
})

// ---------------------------------------------------------------------------
describe("GAP-320 — policy tie-break is deterministic", () => {
  test("two same-scope same-priority policies resolve the same way every call", async () => {
    const vendor = await mkVendor(uniq("Audit Policy Tie"))
    const emp = await mkEmployee(vendor.id)
    const mk = () => db.attendancePolicy.create({ data: { vendorId: vendor.id, companyId: null, name: uniq("P"), policyType: "TRACKING", priority: 1, active: true, configJson: "{}" } as any })
    for (const p of [await mk(), await mk(), await mk()]) {
      await db.attendancePolicyAssignment.create({ data: { vendorId: vendor.id, policyId: p.id, scopeType: "ALL_EMPLOYEES" } as any })
    }
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const r = await resolveEffectivePolicy(vendor.id, emp, "TRACKING" as any)
      seen.add(JSON.stringify(r))
    }
    expect(seen.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-328 — analytics CSV neutralizes formulas but keeps numbers numeric", () => {
  test("text cell guarded, negative number untouched", () => {
    const csv = reportToCsv({
      title: "T", period: { label: "P" }, filters: {}, scope: { description: "S" }, generatedAt: "now",
      kpis: [], charts: [],
      table: { columns: [{ label: "Name" }, { label: "Delta" }], rows: [["=HYPERLINK(\"http://evil\")", -5], ["@cmd", 7]] },
      methodology: {}, warnings: [],
    } as any)
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")",-5`)
    expect(csv).toContain("'@cmd,7")
  })
})

// ---------------------------------------------------------------------------
describe("GAP-207 — notify-only approval escalation already exists (audit false positive)", () => {
  test("HR is reminded after N days, the owner at 2N, for any process type", async () => {
    const vendor = await mkVendor(uniq("Audit Esc"))
    const hr = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, companyId: await defaultCompanyId(vendor.id), processType: "LOAN", name: "W" } as any })
    await db.approvalRequest.create({
      data: { vendorId: vendor.id, companyId: await defaultCompanyId(vendor.id), workflowId: wf.id, processType: "LOAN", entityType: "Loan", entityId: uniq("L"), requestedBy: hr.id, createdAt: new Date(Date.now() - 10 * 86_400_000) } as any,
    })
    const n = await approvalReminderSweep(vendor.id, today(), { approvals: { reminderDays: 3 } })
    expect(n).toBe(1)
    expect(await db.notification.count({ where: { vendorId: vendor.id, userId: hr.id, title: { contains: "Reminder" } } })).toBe(1)
    expect(await db.notification.count({ where: { vendorId: vendor.id, userId: owner.id, title: { contains: "Escalation" } } })).toBe(1)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-208 — bulk KPI rollout", () => {
  test("by branch and by codes, idempotent, one audit row, scoped to the caller's company", async () => {
    const t = await twoCompanyTenant("HR_ADMIN")
    const branch = await db.branch.create({ data: { vendorId: t.vendor.id, companyId: t.companyA, name: "HQ", code: uniq("B") } })
    const mkA = (over: any = {}) => db.employee.create({ data: { vendorId: t.vendor.id, companyId: t.companyA, fullName: "A", code: uniq("E"), joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE", ...over } })
    const inBranch = await mkA({ branchId: branch.id })
    const inBranch2 = await mkA({ branchId: branch.id })
    const elsewhere = await mkA()
    const inB = await db.employee.create({ data: { vendorId: t.vendor.id, companyId: t.companyB, fullName: "B", code: uniq("E"), joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" } })
    const tpl = await db.kpiTemplate.create({ data: { vendorId: t.vendor.id, companyId: t.companyA, name: "Q4 KPI", itemsJson: JSON.stringify([{ name: "Sales", target: 10, unit: "n", weight: 100 }]) } as any })

    const first = await postHrm("kpiAssignments.bulkAssign", { templateId: tpl.id, periodLabel: "2026-Q4", branchId: branch.id }, { bearer: t.tokenA })
    ok(first)
    expect(first.body.data.assigned).toBe(2)
    const again = await postHrm("kpiAssignments.bulkAssign", { templateId: tpl.id, periodLabel: "2026-Q4", branchId: branch.id }, { bearer: t.tokenA })
    expect(again.body.data).toMatchObject({ assigned: 0, alreadyAssigned: 2 })

    const byCode = await postHrm("kpiAssignments.bulkAssign", { templateId: tpl.id, periodLabel: "2026-Q4", employeeCodes: [elsewhere.code, inB.code, "NOPE"] }, { bearer: t.tokenA })
    expect(byCode.body.data.assigned).toBe(1)
    expect(byCode.body.data.unmatchedCodes.sort()).toEqual([inB.code, "NOPE"].sort()) // other company's code never matches
    expect(await db.kpiAssignment.count({ where: { employeeId: inB.id } })).toBe(0)
    expect(await db.kpiAssignment.count({ where: { employeeId: inBranch.id } })).toBe(1)
    expect(await db.kpiAssignment.count({ where: { employeeId: inBranch2.id } })).toBe(1)

    expect(await db.auditLog.count({ where: { vendorId: t.vendor.id, action: "kpiAssignments.bulkAssign" } })).toBe(2)
    expect(await db.notification.count({ where: { vendorId: t.vendor.id, employeeId: inBranch.id, title: "KPI Assigned" } })).toBe(1)
  })

  test("an unfiltered rollout and another company's template are refused", async () => {
    const t = await twoCompanyTenant("HR_ADMIN")
    const tplB = await db.kpiTemplate.create({ data: { vendorId: t.vendor.id, companyId: t.companyB, name: "B KPI", itemsJson: "[]" } as any })
    const tplA = await db.kpiTemplate.create({ data: { vendorId: t.vendor.id, companyId: t.companyA, name: "A KPI", itemsJson: "[]" } as any })
    expect((await postHrm("kpiAssignments.bulkAssign", { templateId: tplA.id, periodLabel: "Q" }, { bearer: t.tokenA })).status).toBe(400)
    expect((await postHrm("kpiAssignments.bulkAssign", { templateId: tplB.id, periodLabel: "Q", employeeCodes: ["X"] }, { bearer: t.tokenA })).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
describe("GAP-330 — role notifications are one INSERT", () => {
  test("every role member gets one row", async () => {
    const vendor = await mkVendor(uniq("Audit Notify"))
    await mkUser(vendor.id, { role: "HR_ADMIN" })
    await mkUser(vendor.id, { role: "HR_ADMIN" })
    const { notify } = await import("@/hrm-server/audit")
    await notify(vendor.id, { role: "HR_ADMIN" }, "T", "M", "SYSTEM")
    expect(await db.notification.count({ where: { vendorId: vendor.id, title: "T" } })).toBe(2)
  })
})

// ---------------------------------------------------------------------------
describe("NEW-003 — raw SQL clocks are UTC regardless of the database timezone", () => {
  test("no bare now() remains in server SQL", () => {
    const root = path.join(import.meta.dir, "..", "..", "src")
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name)) {
          fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return
            if (/\blastStatusCheckAt = now\(\)/.test(line)) return // prose inside a block comment
            if (/(^|[^.\w])now\(\)(?! AT TIME ZONE)/.test(line) && !/\bNOW\(\)/.test(line)) offenders.push(`${p}:${i + 1}`)
          })
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })

  test("a session expiring in 2 hours counts as live under a +06:00 database clock", async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Dhaka'`)
      const soon = new Date(Date.now() + 2 * 3_600_000)
      const rows = await tx.$queryRawUnsafe<{ live: boolean }[]>(`SELECT ($1::timestamp > (now() AT TIME ZONE 'UTC')) AS live`, soon)
      expect(rows[0].live).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
describe("NEW-008 — a newly provisioned tenant can use the product", () => {
  test("approval creates the company, the owner's access row and stamped config", async () => {
    const { provisionTenant } = await import("@/hrm-server/saas/provision")
    const { getCtxFromToken } = await import("@/hrm-server/auth")
    const plan = await db.saasPlan.create({ data: { name: uniq("Trial"), isTrialPlan: true, monthlyPrice: 0, yearlyPrice: 0 } as any })
    const reg = await db.saasRegistration.create({
      data: {
        applicationNumber: uniq("APP"), organizationName: "Fresh Tenant Ltd", organizationType: "PRIVATE_LTD", industry: "Test", country: "Bangladesh", city: "Dhaka",
        officialEmail: `${uniq("info")}@test.local`, adminName: "Fresh Admin", adminDesignation: "MD", adminEmail: `${uniq("admin")}@test.local`, adminPhone: "+8801700000000",
        adminPasswordHash: hashPassword("Fresh-Tenant-Pass-1"), employeeCount: 1, branchCount: 1, deviceCount: 0, requestedModules: "[]",
        planId: plan.id, planName: plan.name, billingCycle: "MONTHLY", status: "UNDER_REVIEW", source: "ADMIN",
      } as any,
    })
    const res = await provisionTenant(reg, plan.id, { name: "Test" })
    const company = await db.company.findFirst({ where: { vendorId: res.vendorId, isDefault: true, active: true } })
    expect(company?.name).toBe("Fresh Tenant Ltd")
    expect(await db.userCompanyAccess.count({ where: { userId: res.adminUserId, companyId: company!.id, isDefault: true } })).toBe(1)
    expect(await db.approvalWorkflow.count({ where: { vendorId: res.vendorId, companyId: null } })).toBe(0)
    expect(await db.leaveType.count({ where: { vendorId: res.vendorId, companyId: null } })).toBe(0)

    const token = await mkSession(res.adminUserId)
    expect((await getCtxFromToken(token))?.activeCompanyId).toBe(company!.id)
    const types = await postHrm("leaveTypes.list", {}, { bearer: token })
    ok(types)
    expect(types.body.data).toHaveLength(7)
    ok(await postHrm("employees.list", {}, { bearer: token }))
  })

  test("the clean owner seed provisions the same context (source guard; full run recorded in the checklist)", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src/hrm-server/seed-owner.ts"), "utf8")
    expect(src).toContain("ensureDefaultCompany(vendor.id")
    expect(src).toContain("ensureProvisioningAccessRow(db")
  })

  test("the demo seed fails loudly if the company pass fails, instead of printing SEED COMPLETE", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src/hrm-server/seed.ts"), "utf8")
    expect(src).not.toContain("multi-company backfill failed")
    expect(src).toContain("information_schema.columns")
  })
})

// ---------------------------------------------------------------------------
describe("Test harness (GAP-101)", () => {
  test("a fixture vendor has a company and a fixture user resolves it through the real session path", async () => {
    const { getCtxFromToken } = await import("@/hrm-server/auth")
    const vendor = await mkVendor(uniq("Audit Harness"))
    const hr = await mkUser(vendor.id, { role: "PAYROLL_OFFICER" })
    const ctx = await getCtxFromToken(await mkSession(hr.id))
    expect(ctx?.activeCompanyId).toBe((await defaultCompanyId(vendor.id))!)
  })

  test("the legacy companyless shape stays available on request", async () => {
    const vendor = await mkVendor(uniq("Audit Legacy"), { company: false })
    expect(await db.company.count({ where: { vendorId: vendor.id } })).toBe(0)
    expect(await defaultCompanyId(vendor.id)).toBeNull()
  })

  test("session token helpers stay wired (sanity for the suite above)", () => {
    expect(sessionTokenHash(newToken())).toHaveLength(64)
    expect(typeof calculateRun).toBe("function")
    expect(typeof payRun).toBe("function")
  })
})

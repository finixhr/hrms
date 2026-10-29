/// <reference types="bun-types" />
// ============ Attendance-route Low findings: L-12, L-13, L-19 ============
// L-12 — attendance.devices.sync sweeps the WHOLE vendor queue but used to
//        report the vendor totals as the requested device's import result.
//        The response now says vendorWide + the device's own pending-before.
// L-13 — the plain (non-GPS) self check-out must respect the
//        ATTENDANCE_METHOD policy: denied whenever a policy exists that does
//        not explicitly permit no-GPS check-outs (SELFIE listed AND
//        requireGeofence off); legacy vendors without a policy keep the old
//        behavior.
// L-19 — corrections.act is gated by the RBAC permission system
//        (attendance.verify) instead of a hardcoded HR_ADMIN/HR_MANAGER role
//        list.
// Route-layer: drives the REAL POST /api/hrm dispatcher.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { today } from "@/hrm-server/utils"

let vendor: { id: string }
let employee: { id: string }
let empToken: string
let adminToken: string

beforeAll(async () => {
  vendor = await mkVendor("L-Attendance Vendor")
  employee = await mkEmployee(vendor.id, { fullName: "L Att Employee" })
  const empUser = await mkUser(vendor.id, { role: "EMPLOYEE", name: "L Att Self", employeeId: employee.id })
  empToken = await mkSession(empUser.id, "FULL")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "L Att Admin", email: `latt-admin-${uniq()}@test.local` })
  adminToken = await mkSession(admin.id, "FULL")
})

describe("L-12 — attendance.devices.sync reports vendor-wide honestly", () => {
  test("response carries vendorWide + the device's own pending-before count", async () => {
    const device = await db.attendanceDevice.create({
      data: { vendorId: vendor.id, deviceId: uniq("DEV"), name: "L12 Terminal", manufacturer: "ZKTeco", protocol: "ADMS", deviceIdentifier: uniq("SN"), serialNumber: uniq("SN"), timezone: "Asia/Dhaka", enabled: true, status: "OFFLINE" } as any,
    })
    const r = await postHrm("attendance.devices.sync", { deviceId: device.id }, { bearer: adminToken })
    expect(r.status).toBe(200)
    expect(r.body?.data?.vendorWide).toBe(true) // the old response implied device-scoped numbers
    expect(typeof r.body?.data?.devicePendingBefore).toBe("number")
  })
})

describe("L-13 — plain self check-out respects the ATTENDANCE_METHOD policy", () => {
  async function mkPolicy(methods: string[], requireGeofence: boolean) {
    const policy = await db.attendancePolicy.create({
      data: {
        vendorId: vendor.id, name: `L13 ${methods.join("+")} ${uniq()}`,
        policyType: "ATTENDANCE_METHOD", active: true,
        daysOfWeek: "SUNDAY,MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY", // suite may run on any day
        configJson: JSON.stringify({ methods, selfieRequired: false, requireGeofence }),
      },
    })
    await db.attendancePolicyAssignment.create({
      data: { vendorId: vendor.id, policyId: policy.id, scopeType: "ALL_EMPLOYEES", scopeId: null },
    })
    return policy.id
  }
  async function withTodaysRecord(): Promise<string> {
    const row = await db.attendance.create({
      data: { vendorId: vendor.id, employeeId: employee.id, date: today(), checkIn: "09:00", workingMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, status: "PRESENT", source: "GEOFENCE" },
    })
    return row.id
  }

  test("default-shape policy (GEOFENCE + DEVICE_PUNCH only) → plain checkout DENIED 403 (was: silent bypass)", async () => {
    await mkPolicy(["GEOFENCE", "DEVICE_PUNCH"], false)
    await withTodaysRecord()
    const r = await postHrm("attendance.selfCheckout", {}, { bearer: empToken })
    expect(r.status).toBe(403)
    expect(String(r.body?.error || "")).toContain("GPS")
    // the day is NOT closed by the denied plain checkout
    const row = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: employee.id, date: today() } })
    expect(row?.checkOut).toBeFalsy()
  })

  test("policy that explicitly permits no-GPS check-outs (SELFIE, requireGeofence off) → allowed", async () => {
    // highest-priority effective policy wins: give this one a higher priority
    const policy = await db.attendancePolicy.create({
      data: {
        vendorId: vendor.id, name: `L13 permissive ${uniq()}`,
        policyType: "ATTENDANCE_METHOD", active: true, priority: 10,
        daysOfWeek: "SUNDAY,MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY",
        configJson: JSON.stringify({ methods: ["GEOFENCE", "SELFIE"], selfieRequired: false, requireGeofence: false }),
      },
    })
    await db.attendancePolicyAssignment.create({ data: { vendorId: vendor.id, policyId: policy.id, scopeType: "ALL_EMPLOYEES", scopeId: null } })
    await db.attendance.updateMany({ where: { vendorId: vendor.id, employeeId: employee.id, date: today() }, data: { checkOut: null } })
    const r = await postHrm("attendance.selfCheckout", {}, { bearer: empToken })
    expect(r.status).toBe(200)
  })

  test("vendor WITHOUT any method policy keeps the legacy plain checkout", async () => {
    const v2 = await mkVendor("L13 Legacy Vendor")
    const emp2 = await mkEmployee(v2.id, { fullName: "L13 Legacy Emp" })
    const u2 = await mkUser(v2.id, { role: "EMPLOYEE", employeeId: emp2.id })
    const t2 = await mkSession(u2.id, "FULL")
    await db.attendance.create({
      data: { vendorId: v2.id, employeeId: emp2.id, date: today(), checkIn: "09:00", workingMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, status: "PRESENT", source: "GEOFENCE" },
    })
    const r = await postHrm("attendance.selfCheckout", {}, { bearer: t2 })
    expect(r.status).toBe(200)
  })
})

describe("L-19 — corrections.act is gated by the RBAC permission system", () => {
  async function mkPendingCorrection(): Promise<string> {
    return (await db.attendanceCorrection.create({
      data: { vendorId: vendor.id, employeeId: employee.id, date: today(), requestedIn: "09:05", requestedOut: "18:00", reason: "L-19 gate test", status: "PENDING" } as any,
    })).id
  }

  test("HR_MANAGER (attendance.verify via role template) can decide", async () => {
    const id = await mkPendingCorrection()
    const hr = await mkUser(vendor.id, { role: "HR_MANAGER", email: `l19-hr-${uniq()}@test.local` })
    const t = await mkSession(hr.id, "FULL")
    const r = await postHrm("attendance.corrections.act", { id, decision: "REJECTED" }, { bearer: t })
    expect(r.status).toBe(200)
    expect(r.body?.data?.status).toBe("REJECTED")
  })

  test("a role WITHOUT attendance.verify is denied by the dispatcher (was: also denied, but by a hardcoded role list)", async () => {
    const id = await mkPendingCorrection()
    // BRANCH_MANAGER template carries attendance view/create/edit/export but
    // NOT verify — the permission system now decides
    const bm = await mkUser(vendor.id, { role: "BRANCH_MANAGER", email: `l19-bm-${uniq()}@test.local` })
    const t = await mkSession(bm.id, "FULL")
    const r = await postHrm("attendance.corrections.act", { id, decision: "REJECTED" }, { bearer: t })
    expect(r.status).toBe(403)
    expect((await db.attendanceCorrection.findUnique({ where: { id } }))?.status).toBe("PENDING")
  })

  test("source invariant: no hardcoded role list remains in corrections.act", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/hrm-server/routes/attendance.ts", "utf8")
    expect(src).not.toContain('["HR_ADMIN", "HR_MANAGER"].includes(ctx.role)')
    expect(src).toContain('route("attendance.corrections.act"')
  })
})

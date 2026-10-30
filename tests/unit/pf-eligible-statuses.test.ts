/// <reference types="bun-types" />
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { mkVendor, mkUser, mkSession } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"

let vendor: any
let admin: any
let token: string

beforeAll(async () => {
  vendor = await mkVendor("PF Eligible Statuses Test Vendor")
  admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "PF Admin" })
  token = await mkSession(admin.id, "FULL")
})

describe("Provident Fund — Eligible Employee Statuses Policy", () => {
  test("persists eligibleStatuses in settings under group 'pf'", async () => {
    const saveRes = await postHrm("settings.save", {
      group: "pf",
      values: {
        enabled: true,
        employeePct: 10,
        employerPct: 10,
        basis: "BASIC",
        minServiceMonths: 0,
        autoEnroll: true,
        eligibleStatuses: ["ACTIVE", "PROBATION", "ON_LEAVE"],
      },
    }, { bearer: token })

    expect(saveRes.status).toBe(200)
    expect(saveRes.body.ok).toBe(true)

    const getRes = await postHrm("settings.get", {}, { bearer: token })
    expect(getRes.status).toBe(200)
    expect(getRes.body.data.pf.enabled).toBe(true)
    expect(getRes.body.data.pf.eligibleStatuses).toEqual(["ACTIVE", "PROBATION", "ON_LEAVE"])
  })

  test("autoEnrollRun only enrolls employees with eligible status", async () => {
    // Create employees with different statuses
    const empActive = await db.employee.create({
      data: {
        vendorId: vendor.id,
        code: "EMP-ACT-1",
        fullName: "Active Employee",
        status: "ACTIVE",
        joiningDate: "2025-01-01",
      },
    })

    const empSuspended = await db.employee.create({
      data: {
        vendorId: vendor.id,
        code: "EMP-SUS-1",
        fullName: "Suspended Employee",
        status: "SUSPENDED",
        joiningDate: "2025-01-01",
      },
    })

    const empTerminated = await db.employee.create({
      data: {
        vendorId: vendor.id,
        code: "EMP-TERM-1",
        fullName: "Terminated Employee",
        status: "TERMINATED",
        joiningDate: "2025-01-01",
      },
    })

    // Run auto-enroll
    const runRes = await postHrm("pf.autoEnrollRun", {}, { bearer: token })
    expect(runRes.status).toBe(200)

    // Check enrollments: only Active should be enrolled, not Suspended or Terminated
    const enrollActive = await db.pfEnrollment.findFirst({
      where: { vendorId: vendor.id, employeeId: empActive.id },
    })
    expect(enrollActive).not.toBeNull()

    const enrollSuspended = await db.pfEnrollment.findFirst({
      where: { vendorId: vendor.id, employeeId: empSuspended.id },
    })
    expect(enrollSuspended).toBeNull()

    const enrollTerminated = await db.pfEnrollment.findFirst({
      where: { vendorId: vendor.id, employeeId: empTerminated.id },
    })
    expect(enrollTerminated).toBeNull()
  })

  test("pf.enroll blocks manual enrollment of employees with ineligible status", async () => {
    const empInactive = await db.employee.create({
      data: {
        vendorId: vendor.id,
        code: "EMP-INACT-1",
        fullName: "Inactive Person",
        status: "INACTIVE",
        joiningDate: "2025-01-01",
      },
    })

    const res = await postHrm("pf.enroll", {
      employeeId: empInactive.id,
      employeePct: 10,
      employerPct: 10,
    }, { bearer: token })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/only employees with status/i)
  })
})

/// <reference types="bun-types" />
// ============ Employee 360° Profile Redesign Verification Tests ============
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { mkVendor, mkUser, mkEmployee, makeCtx } from "./_fixtures"

let vendor: { id: string; name: string }
let foreignVendor: { id: string }
let emp: { id: string; code: string; fullName: string }
let hrAdmin: any
let foreignAdmin: any
let branch: any
let dept: any
let desigOld: any
let desigNew: any

beforeAll(async () => {
  vendor = await mkVendor("Profile Redesign Corp")
  foreignVendor = await mkVendor("Foreign Corp")

  branch = await db.branch.create({
    data: { vendorId: vendor.id, name: "Dhaka HQ", code: "DHK" },
  })
  dept = await db.department.create({
    data: { vendorId: vendor.id, name: "Engineering", code: "ENG" },
  })
  desigOld = await db.designation.create({
    data: { vendorId: vendor.id, name: "Junior Software Engineer", code: "JSE" },
  })
  desigNew = await db.designation.create({
    data: { vendorId: vendor.id, name: "Senior Software Engineer", code: "SSE" },
  })

  emp = await mkEmployee(vendor.id, {
    fullName: "Kamrul Hasan",
  })

  await db.employee.update({
    where: { id: emp.id },
    data: {
      branchId: branch.id,
      departmentId: dept.id,
      designationId: desigOld.id,
      taxTin: "123456789012",
      mobile: "01712345678",
      officialEmail: "kamrul@profileredesign.com",
      joiningDate: "2023-01-15",
      confirmationDate: "2023-07-15",
    },
  })

  // Add initial salary structure
  await db.salaryStructure.create({
    data: {
      vendorId: vendor.id,
      employeeId: emp.id,
      basic: 60000,
      houseRent: 30000,
      medical: 6000,
      gross: 96000,
      effectiveFrom: "2023-01-15",
      status: "ACTIVE",
    },
  })

  // Add an asset assignment
  const asset = await db.asset.create({
    data: {
      vendorId: vendor.id,
      code: "AST-0099",
      name: "MacBook Pro 16",
      category: "LAPTOP",
      brandModel: "Apple M3 Pro",
      serialImei: "C02XYZ123456",
      condition: "GOOD",
      status: "ASSIGNED",
    },
  })

  await db.assetAssignment.create({
    data: {
      vendorId: vendor.id,
      employeeId: emp.id,
      assetId: asset.id,
      assignedAt: new Date("2023-01-16"),
      conditionOut: "GOOD",
      note: "Primary dev machine",
    },
  })

  // Add a document
  await db.employeeDocument.create({
    data: {
      vendorId: vendor.id,
      employeeId: emp.id,
      category: "IDENTITY",
      docType: "NID",
      title: "National ID Card",
      docNumber: "19901234567890123",
      verified: true,
      status: "VALID",
    },
  })

  // Add approval workflow for promotion
  const wf = await db.approvalWorkflow.create({
    data: {
      vendorId: vendor.id,
      processType: "PROMOTION",
      name: "Promotion Workflow",
      active: true,
    },
  })
  await db.approvalStep.create({
    data: {
      vendorId: wf.vendorId,
      workflowId: wf.id,
      sequence: 1,
      name: "HR Admin Review",
      approverRole: "HR_ADMIN",
    },
  })

  hrAdmin = await mkUser(vendor.id, { role: "HR_ADMIN" })
  foreignAdmin = await mkUser(foreignVendor.id, { role: "HR_ADMIN" })
})

describe("Employee 360° Profile Redesign Data & Workflow Contract", () => {
  test("employees.get returns all datasets required by the redesigned 360 tabs", async () => {
    const handler = getRoute("employees.get")?.handler as any
    const ctx = makeCtx(hrAdmin)

    const res: any = await handler(ctx, { id: emp.id })
    expect(res).toBeDefined()
    expect(res.employee).toBeDefined()
    expect(res.employee.fullName).toBe("Kamrul Hasan")
    expect(res.employee.taxTin).toBe("123456789012")
    expect(res.employee.nid).toBe("19901234567890123")
    expect(res.employee.branchName).toBe("Dhaka HQ")
    expect(res.employee.departmentName).toBe("Engineering")
    expect(res.employee.designationName).toBe("Junior Software Engineer")

    // Active salary structure
    expect(res.structure).toBeDefined()
    expect(res.structure.basic).toBe(60000)
    expect(res.structure.gross).toBe(96000)

    // Assigned assets dataset (used by AssetsTab)
    expect(Array.isArray(res.assignedAssets)).toBe(true)
    expect(res.assignedAssets.length).toBe(1)
    expect(res.assignedAssets[0].asset.code).toBe("AST-0099")
    expect(res.assignedAssets[0].asset.name).toBe("MacBook Pro 16")
    expect(res.assignedAssets[0].asset.brandModel).toBe("Apple M3 Pro")

    // Documents dataset (used by DocumentsTab)
    expect(Array.isArray(res.docs)).toBe(true)
    expect(res.docs.length).toBeGreaterThanOrEqual(1)

    // Career progression datasets (used by CareerTab)
    expect(Array.isArray(res.promotions)).toBe(true)
    expect(Array.isArray(res.transfers)).toBe(true)
    expect(Array.isArray(res.revisions)).toBe(true)

    // Lookups for action dialogs
    expect(res.lookups).toBeDefined()
    expect(Array.isArray(res.lookups.designations)).toBe(true)
    expect(Array.isArray(res.lookups.branches)).toBe(true)
  })

  test("lifecycle.promote creates a promotion record and reflects in career progression", async () => {
    const promoteHandler = getRoute("lifecycle.promote")?.handler as any
    const ctx = makeCtx(hrAdmin)

    const promo: any = await promoteHandler(ctx, {
      employeeId: emp.id,
      newDesignationId: desigNew.id,
      newBasicSalary: 75000,
      newGrade: "A-1",
      effectiveDate: "2024-01-01",
      reason: "Outstanding performance as Junior Dev",
    })
    expect(promo).toBeDefined()
    expect(promo.status).toBe("PENDING")

    // Apply promotion (via lifecycle hook)
    const { applyPromotion } = await import("@/hrm-server/routes/lifecycle")
    await applyPromotion(promo.id, hrAdmin.id, vendor.id, "APPROVED")

    // Fetch updated 360 profile
    const getHandler = getRoute("employees.get")?.handler as any
    const res: any = await getHandler(ctx, { id: emp.id })

    expect(res.promotions.length).toBeGreaterThanOrEqual(1)
    const latestPromo = res.promotions[0]
    expect(latestPromo.newDesignation).toBe("Senior Software Engineer")
    expect(latestPromo.newGrade).toBe("A-1")
    expect(latestPromo.reason).toBe("Outstanding performance as Junior Dev")

    // Employee current designation should be updated
    expect(res.employee.designationName).toBe("Senior Software Engineer")
  })

  test("tenant isolation prevents foreign vendor from accessing employee 360", async () => {
    const handler = getRoute("employees.get")?.handler as any
    const foreignCtx = makeCtx(foreignAdmin)

    await expect(handler(foreignCtx, { id: emp.id })).rejects.toThrow()
  })

  test("quick actions backend contracts: attendanceHistory, ait profile, payslips and leave", async () => {
    const ctx = makeCtx(hrAdmin)

    // 1. Attendance History contract
    const attHandler = getRoute("employees.attendanceHistory")?.handler as any
    const attRes = await attHandler(ctx, {
      employeeId: emp.id,
      from: "2024-01-01",
      to: "2024-01-31",
    })
    expect(attRes).toBeDefined()
    expect(attRes.summary).toBeDefined()
    expect(Array.isArray(attRes.records)).toBe(true)

    // 2. AIT Profile contract
    const aitHandler = getRoute("ait.employee.profile")?.handler as any
    const aitRes = await aitHandler(ctx, { employeeId: emp.id })
    expect(aitRes).toBeDefined()
    expect(aitRes.employeeId).toBe(emp.id)
    expect(aitRes.taxTin).toBe("123456789012")

    // 3. Payslips contract
    const payslipHandler = getRoute("payslips.list")?.handler as any
    const payslipRes = await payslipHandler(ctx, { employeeId: emp.id })
    expect(Array.isArray(payslipRes)).toBe(true)

    // 4. Leave requests contract
    const leaveHandler = getRoute("leaveRequests.list")?.handler as any
    const leaveRes = await leaveHandler(ctx, { employeeId: emp.id })
    expect(Array.isArray(leaveRes)).toBe(true)

    // 5. Loans contract
    const loanHandler = getRoute("loans.list")?.handler as any
    const loanRes = await loanHandler(ctx, {})
    expect(Array.isArray(loanRes)).toBe(true)
  })
})

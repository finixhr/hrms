/// <reference types="bun-types" />
// ============ Employee 360° Profile Print & Export CV Tests ============
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { readPiiText } from "@/hrm-server/pii-field"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"

let vendor: { id: string; name: string }
let foreignVendor: { id: string }
let emp: { id: string; code: string; fullName: string }
let asset: { id: string; code: string }
let hrAdmin: any
let branchManager: any

beforeAll(async () => {
  vendor = await mkVendor("Apex Technologies Ltd")
  foreignVendor = await mkVendor("Foreign Corp")

  // Update vendor with company branding details
  await db.vendor.update({
    where: { id: vendor.id },
    data: {
      legalName: "Apex Technologies Bangladesh PLC",
      address: "Plot 42, Gulshan-2, Dhaka-1212",
      phone: "+880 1711-000000",
      email: "info@apextech.com",
      logoUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      signatoryName: "Rafiqul Islam",
      signatoryDesignation: "Director & Head of People",
    },
  })

  // Create employee with personal biodata
  emp = await mkEmployee(vendor.id, {
    fullName: "Tariqul Islam",
  })

  await db.employee.update({
    where: { id: emp.id },
    data: {
      dob: "1990-05-15",
      gender: "MALE",
      bloodGroup: "B+",
      maritalStatus: "MARRIED",
      nationality: "Bangladeshi",
      religion: "Islam",
      mobile: "+880 1812-345678",
      officialEmail: "tariqul@apextech.com",
      personalEmail: "tariqul.islam@gmail.com",
      presentAddress: "House 12, Road 4, Sector 7, Uttara, Dhaka",
      emergencyName: "Nusrat Jahan",
      emergencyRelation: "SPOUSE",
      emergencyMobile: "+880 1812-999999",
      joiningDate: "2021-03-01",
    },
  })

  // Create academic qualifications
  await db.education.create({
    data: {
      id: uniq("edu"),
      vendorId: vendor.id,
      employeeId: emp.id,
      degree: "B.Sc. in Computer Science",
      institution: "BUET",
      board: "Dhaka",
      major: "Computer Science & Engineering",
      passingYear: "2012",
      result: "CGPA 3.82/4.00",
    },
  })

  // Create professional work experience
  await db.previousEmployment.create({
    data: {
      id: uniq("prev"),
      vendorId: vendor.id,
      employeeId: emp.id,
      company: "DataSoft Systems Bangladesh",
      designation: "Senior Software Engineer",
      department: "Enterprise Solutions",
      joinDate: "2016-01-15",
      leaveDate: "2021-02-28",
      reasonForLeaving: "Career Progression",
      supervisor: "Abdul Karim (Engineering Manager)",
      contact: "+880 1711-223344",
    },
  })

  // Create reference
  await db.referee.create({
    data: {
      id: uniq("ref"),
      vendorId: vendor.id,
      employeeId: emp.id,
      name: "Dr. Mohammad Zahir",
      organization: "BUET",
      designation: "Professor",
      relationship: "Academic Thesis Supervisor",
      type: "PROFESSIONAL",
      mobile: "+880 1911-334455",
      verificationStatus: "VERIFIED",
    },
  })

  // Create family member
  await db.familyMember.create({
    data: {
      id: uniq("fam"),
      vendorId: vendor.id,
      employeeId: emp.id,
      name: "Nusrat Jahan",
      relationship: "SPOUSE",
      gender: "FEMALE",
      occupation: "Teacher",
      dependent: true,
      mobile: "+880 1812-999999",
    },
  })

  // Create asset and assignment
  const assetCode = uniq("AST-").slice(0, 10)
  asset = await db.asset.create({
    data: {
      id: uniq("ast"),
      vendorId: vendor.id,
      code: assetCode,
      name: "MacBook Pro 16",
      category: "LAPTOP",
      brandModel: "Apple MacBook Pro M3 Max",
      serialImei: "C02XYZ12345",
      status: "ASSIGNED",
    },
  })

  await db.assetAssignment.create({
    data: {
      id: uniq("asg"),
      vendorId: vendor.id,
      assetId: asset.id,
      employeeId: emp.id,
      assignedAt: new Date("2021-03-05"),
      conditionOut: "NEW",
    },
  })

  // Create designations & promotion
  const desig1 = await db.designation.create({
    data: { id: uniq("desig"), vendorId: vendor.id, code: uniq("LE").slice(0, 10), name: "Lead Engineer" },
  })
  const desig2 = await db.designation.create({
    data: { id: uniq("desig"), vendorId: vendor.id, code: uniq("PA").slice(0, 10), name: "Principal Architect" },
  })

  await db.promotion.create({
    data: {
      id: uniq("promo"),
      vendorId: vendor.id,
      employeeId: emp.id,
      oldDesignationId: desig1.id,
      newDesignationId: desig2.id,
      effectiveDate: "2023-01-01",
      reason: "Annual performance appraisal and technical leadership",
    },
  })

  // Create users
  hrAdmin = await mkUser(vendor.id, { role: "HR_ADMIN" })
  branchManager = await mkUser(vendor.id, { role: "BRANCH_MANAGER" })
})

describe("Unified Employee 360° Profile Print Data Aggregation", () => {
  test("employees.get returns complete company branding from tenant vendor and settings", async () => {
    const def = getRoute("employees.get")!
    const out = (await def.handler(makeCtx(hrAdmin), { id: emp.id })) as any

    expect(out.company).toBeDefined()
    expect(out.company.legalName).toBe("Apex Technologies Bangladesh PLC")
    expect(out.company.address).toBe("Plot 42, Gulshan-2, Dhaka-1212")
    expect(out.company.phone).toBe("+880 1711-000000")
    expect(out.company.email).toBe("info@apextech.com")
    expect(out.company.logoUrl).toContain("data:image/png;base64")
    expect(out.company.signatoryName).toBe("Rafiqul Islam")
  })

  test("employees.get returns aggregated education, experience, family, references, and promotions", async () => {
    const def = getRoute("employees.get")!
    const out = (await def.handler(makeCtx(hrAdmin), { id: emp.id })) as any

    // Employee core info
    expect(out.employee.fullName).toBe("Tariqul Islam")
    expect(out.employee.bloodGroup).toBe("B+")
    expect(out.employee.emergencyName).toBe("Nusrat Jahan")

    // Academic qualifications
    expect(out.education.length).toBeGreaterThanOrEqual(1)
    expect(out.education[0].degree).toBe("B.Sc. in Computer Science")
    expect(out.education[0].institution).toBe("BUET")

    // Professional work experience
    expect(out.prevEmployment.length).toBeGreaterThanOrEqual(1)
    expect(out.prevEmployment[0].company).toBe("DataSoft Systems Bangladesh")
    expect(out.prevEmployment[0].designation).toBe("Senior Software Engineer")

    // References
    expect(out.references.length).toBeGreaterThanOrEqual(1)
    expect(out.references[0].name).toBe("Dr. Mohammad Zahir")
    expect(out.references[0].organization).toBe("BUET")

    // Family details
    expect(out.family.length).toBeGreaterThanOrEqual(1)
    expect(out.family[0].name).toBe("Nusrat Jahan")
    expect(out.family[0].dependent).toBe(true)

    // Internal career progression
    expect(out.promotions.length).toBeGreaterThanOrEqual(1)
    expect(out.promotions[0].newDesignation).toBe("Principal Architect")
  })

  test("employees.get includes actively assigned company assets", async () => {
    const def = getRoute("employees.get")!
    const out = (await def.handler(makeCtx(hrAdmin), { id: emp.id })) as any

    expect(out.assignedAssets).toBeDefined()
    expect(out.assignedAssets.length).toBeGreaterThanOrEqual(1)
    expect(out.assignedAssets[0].asset.name).toBe("MacBook Pro 16")
    expect(out.assignedAssets[0].asset.category).toBe("LAPTOP")
    expect(out.assignedAssets[0].asset.serialImei).toBe("C02XYZ12345")
  })
})

describe("Tenant Isolation and Security", () => {
  test("cross-tenant employee access is blocked with 404 (anti-enumeration)", async () => {
    const foreignUser = await mkUser(foreignVendor.id, { role: "HR_ADMIN" })
    const def = getRoute("employees.get")!

    expect(def.handler(makeCtx(foreignUser), { id: emp.id })).rejects.toThrow()
  })

  test("employees.auditPrint logs print event in audit trail", async () => {
    const def = getRoute("employees.auditPrint")!
    const beforeCount = await db.auditLog.count({
      where: { vendorId: vendor.id, action: "employees.print" },
    })

    const res = await def.handler(makeCtx(hrAdmin), { id: emp.id })
    expect(res).toEqual({ ok: true })

    const afterCount = await db.auditLog.count({
      where: { vendorId: vendor.id, action: "employees.print" },
    })
    expect(afterCount).toBe(beforeCount + 1)

    const log = await db.auditLog.findFirst({
      where: { vendorId: vendor.id, action: "employees.print", entityId: emp.id },
      orderBy: { createdAt: "desc" },
    })
    expect(log?.summary).toContain("Tariqul Islam")
  })

  test("employees.auditPrint rejects cross-tenant employee printing", async () => {
    const foreignUser = await mkUser(foreignVendor.id, { role: "HR_ADMIN" })
    const def = getRoute("employees.auditPrint")!

    expect(def.handler(makeCtx(foreignUser), { id: emp.id })).rejects.toThrow()
  })
})

describe("Employee NID / Birth / Passport No & TIN Flow", () => {
  test("createWithStructure saves NID and TIN and creates EmployeeDocument", async () => {
    const createDef = getRoute("employees.createWithStructure")!
    const res = (await createDef.handler(makeCtx(hrAdmin), {
      fullName: "Kamal Hossain",
      gender: "MALE",
      maritalStatus: "SINGLE",
      dob: "1994-08-20",
      joiningDate: "2024-01-01",
      employmentType: "PERMANENT",
      taxTin: "123456789012",
      identityType: "NID",
      identityNumber: "19941234567890123",
      basic: 30000,
    })) as any

    expect(res.id).toBeDefined()
    expect(res.code).toBeDefined()

    // Verify employee record has taxTin
    const savedEmp = await db.employee.findUnique({ where: { id: res.id } })
    expect(savedEmp?.taxTin).toBe("123456789012")

    // Verify identity document was created — F28 (P6): raw row encrypted at rest
    const doc = await db.employeeDocument.findFirst({
      where: { vendorId: vendor.id, employeeId: res.id, category: "IDENTITY" },
    })
    expect(doc).toBeDefined()
    expect(doc?.docType).toBe("NID")
    expect(doc?.docNumber?.startsWith("enc::")).toBe(true)
    expect(readPiiText(doc?.docNumber)).toBe("19941234567890123")
    expect(doc?.title).toBe("National ID Card")

    // Verify employees.get exposes them
    const getDef = getRoute("employees.get")!
    const out = (await getDef.handler(makeCtx(hrAdmin), { id: res.id })) as any
    expect(out.employee.taxTin).toBe("123456789012")
    expect(out.employee.nid).toBe("19941234567890123")
    expect(out.employee.identityNumber).toBe("19941234567890123")
    expect(out.employee.identityType).toBe("NID")
  })

  test("employees.update updates Passport/Birth Reg and TIN", async () => {
    // Create an employee first
    const createDef = getRoute("employees.create")!
    const res = (await createDef.handler(makeCtx(hrAdmin), {
      fullName: "Fatima Begum",
      gender: "FEMALE",
      maritalStatus: "MARRIED",
      dob: "1992-04-10",
      joiningDate: "2023-06-01",
      employmentType: "PERMANENT",
      identityType: "NID",
      identityNumber: "1234567890",
    })) as any

    // Now update with Passport and new TIN
    const updateDef = getRoute("employees.update")!
    await updateDef.handler(makeCtx(hrAdmin), {
      id: res.id,
      fullName: "Fatima Begum",
      identityType: "PASSPORT",
      identityNumber: "A01234567",
      taxTin: "987654321098",
    })

    // Verify update
    const getDef = getRoute("employees.get")!
    const out = (await getDef.handler(makeCtx(hrAdmin), { id: res.id })) as any
    expect(out.employee.taxTin).toBe("987654321098")
    expect(out.employee.identityType).toBe("PASSPORT")
    expect(out.employee.identityNumber).toBe("A01234567")

    const doc = await db.employeeDocument.findFirst({
      where: { vendorId: vendor.id, employeeId: res.id, category: "IDENTITY" },
    })
    expect(doc?.docType).toBe("PASSPORT")
    // F28 (P6) — raw row encrypted at rest; readPiiText recovers the number
    expect(doc?.docNumber?.startsWith("enc::")).toBe(true)
    expect(readPiiText(doc?.docNumber)).toBe("A01234567")
    expect(doc?.title).toBe("Passport")
  })
})


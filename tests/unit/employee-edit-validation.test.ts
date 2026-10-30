/// <reference types="bun-types" />
// ============ Employee Edit Form UX/UI & Validation Tests ============
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { readPiiText } from "@/hrm-server/pii-field"
import { mkVendor, mkUser, mkEmployee, makeCtx } from "./_fixtures"
import { validateEmployeeEditForm, FORM_SECTIONS, type SectionKey } from "@/hrm/views/employee-edit-dialog"

let vendor: { id: string; name: string }
let foreignVendor: { id: string }
let emp: { id: string; code: string; fullName: string }
let managerEmp: { id: string; code: string; fullName: string }
let hrAdmin: any

beforeAll(async () => {
  vendor = await mkVendor("Finix Technologies Ltd")
  foreignVendor = await mkVendor("Cross Vendor Ltd")

  emp = await mkEmployee(vendor.id, {
    fullName: "Kamal Hossain",
  })
  await db.employee.update({
    where: { id: emp.id },
    data: { joiningDate: "2022-01-15" },
  })

  managerEmp = await mkEmployee(vendor.id, {
    fullName: "Shafiqul Alam",
  })
  await db.employee.update({
    where: { id: managerEmp.id },
    data: { joiningDate: "2020-05-10" },
  })

  hrAdmin = await mkUser(vendor.id, {
    permissions: ["employees.view", "employees.edit", "bankInfo.view", "bankInfo.edit"],
  })
})

describe("Client-side Form Validation — validateEmployeeEditForm", () => {
  test("FORM_SECTIONS metadata defines all 8 logical groups with icons and numbers", () => {
    expect(FORM_SECTIONS.length).toBe(8)
    const expectedIds: SectionKey[] = ["basic", "personal", "identity", "address", "organization", "lifecycle", "attendance", "compensation"]
    expect(FORM_SECTIONS.map((s) => s.id)).toEqual(expectedIds)
    FORM_SECTIONS.forEach((sec, idx) => {
      expect(sec.number).toBe(idx + 1)
      expect(sec.title).toBeTruthy()
      expect(sec.icon).toBeTruthy()
    })
  })

  test("Group 1: Basic Information — enforces required full name with minimum 2 characters", () => {
    const emptyRes = validateEmployeeEditForm({ fullName: "" }, emp)
    expect(emptyRes.isValid).toBe(false)
    expect(emptyRes.errors.fullName).toBe("Full Name is required")
    expect(emptyRes.sectionErrors.basic).toBe(1)
    expect(emptyRes.firstInvalidSection).toBe("basic")

    const shortRes = validateEmployeeEditForm({ fullName: "A" }, emp)
    expect(shortRes.isValid).toBe(false)
    expect(shortRes.errors.fullName).toBe("Full Name must be at least 2 characters")

    const validRes = validateEmployeeEditForm({ fullName: "Kamal Hossain", joiningDate: "2022-01-15" }, emp)
    expect(validRes.sectionErrors.basic).toBe(0)
  })

  test("Group 2: Personal & Family Information — rejects future DOB and validates labor law age", () => {
    const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10)
    const futureRes = validateEmployeeEditForm({ fullName: "Kamal Hossain", joiningDate: "2022-01-15", dob: tomorrow }, emp)
    expect(futureRes.isValid).toBe(false)
    expect(futureRes.errors.dob).toBe("Date of birth cannot be in the future")
    expect(futureRes.sectionErrors.personal).toBe(1)

    // Child labor check (< 14 years old under Bangladesh labor law)
    const childDob = new Date(Date.now() - 365.25 * 24 * 3600 * 1000 * 10).toISOString().slice(0, 10)
    const childRes = validateEmployeeEditForm({ fullName: "Kamal Hossain", joiningDate: "2022-01-15", dob: childDob }, emp)
    expect(childRes.isValid).toBe(false)
    expect(childRes.errors.dob).toContain("at least 14 years old")

    // Valid DOB
    const validDobRes = validateEmployeeEditForm({ fullName: "Kamal Hossain", joiningDate: "2022-01-15", dob: "1992-06-20" }, emp)
    expect(validDobRes.sectionErrors.personal).toBe(0)
  })

  test("Group 3: Identity & Contacts — validates email formats, mobile lengths, and NID numbers", () => {
    const badEmailRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2022-01-15",
      personalEmail: "invalid-email-address",
      officialEmail: "@invalid.domain",
    }, emp)
    expect(badEmailRes.errors.personalEmail).toBe("Invalid personal email address format")
    expect(badEmailRes.errors.officialEmail).toBe("Invalid official email address format")
    expect(badEmailRes.sectionErrors.identity).toBe(2)

    // NID validation
    const badNidRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2022-01-15",
      identityType: "NID",
      identityNumber: "12345", // invalid length
    }, emp)
    expect(badNidRes.errors.identityNumber).toBe("NID must be 10, 13 or 17 digits")

    // Valid 10-digit NID passes
    const validNidRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2022-01-15",
      identityType: "NID",
      identityNumber: "1992123456",
      personalEmail: "kamal@example.com",
    }, emp)
    expect(validNidRes.sectionErrors.identity).toBe(0)
  })

  test("Group 5: Organizational & Job — blocks self-reporting hierarchy", () => {
    const selfManagerRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2022-01-15",
      reportingManagerId: emp.id,
      supervisorId: emp.id,
      hrManagerId: emp.id,
    }, emp)
    expect(selfManagerRes.isValid).toBe(false)
    expect(selfManagerRes.errors.reportingManagerId).toBe("An employee cannot be their own reporting manager")
    expect(selfManagerRes.errors.supervisorId).toBe("An employee cannot be their own supervisor")
    expect(selfManagerRes.errors.hrManagerId).toBe("An employee cannot be their own HR manager")
    expect(selfManagerRes.sectionErrors.organization).toBe(3)

    // Other manager passes
    const otherManagerRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2022-01-15",
      reportingManagerId: managerEmp.id,
    }, emp)
    expect(otherManagerRes.sectionErrors.organization).toBe(0)
  })

  test("Group 6: Employment & Lifecycle — enforces confirmationDate >= joiningDate and contractEnd >= contractStart", () => {
    const badConfRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2023-06-01",
      confirmationDate: "2023-01-01", // earlier than joining
    }, emp)
    expect(badConfRes.errors.confirmationDate).toBe("Confirmation date cannot precede joining date")
    expect(badConfRes.sectionErrors.lifecycle).toBe(1)

    const badContractRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2023-06-01",
      contractStart: "2023-06-01",
      contractEnd: "2023-03-01", // earlier than start
    }, emp)
    expect(badContractRes.errors.contractEnd).toBe("Contract end date cannot precede contract start date")

    const negProbationRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2023-06-01",
      probationMonths: -2,
    }, emp)
    expect(negProbationRes.errors.probationMonths).toBe("Probation period must be 0 or more months")
  })

  test("Group 8: Compensation & Tax — validates e-TIN 12 digits and bank payout credentials", () => {
    const badTinRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2023-06-01",
      taxTin: "12345", // too short
    }, emp)
    expect(badTinRes.errors.taxTin).toBe("e-TIN must be 12 digits")
    expect(badTinRes.sectionErrors.compensation).toBe(1)

    // Payout credentials validation when __editPayout is active
    const badPayoutRes = validateEmployeeEditForm({
      fullName: "Kamal Hossain",
      joiningDate: "2023-06-01",
      __editPayout: true,
      payoutMethod: "BANK",
      payoutAccountNumber: "123", // too short
      payoutRoutingNumber: "1234", // not 9 digits
    }, emp)
    expect(badPayoutRes.errors.payoutAccountNumber).toBe("Bank account number must be at least 6 characters")
    expect(badPayoutRes.errors.payoutRoutingNumber).toBe("Bangladesh bank routing number must be 9 digits")
  })
})

describe("Server-Side Authoritative Validation — employees.update", () => {
  const updateRoute = getRoute("employees.update")!

  test("rejects future date of birth with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.edit"])
    const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10)
    expect(updateRoute.handler(ctx, { id: emp.id, dob: tomorrow })).rejects.toThrow("Date of birth cannot be in the future")
  })

  test("rejects confirmationDate preceding joiningDate with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.edit"])
    expect(
      updateRoute.handler(ctx, {
        id: emp.id,
        joiningDate: "2023-06-01",
        confirmationDate: "2023-02-01",
      })
    ).rejects.toThrow("Confirmation date cannot precede joining date")
  })

  test("rejects contractEnd preceding contractStart with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.edit"])
    expect(
      updateRoute.handler(ctx, {
        id: emp.id,
        contractStart: "2024-01-01",
        contractEnd: "2023-12-01",
      })
    ).rejects.toThrow("Contract end date cannot precede contract start date")
  })

  test("rejects self as reporting manager with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.edit"])
    expect(
      updateRoute.handler(ctx, {
        id: emp.id,
        reportingManagerId: emp.id,
      })
    ).rejects.toThrow("An employee cannot be their own reporting manager")
  })

  test("rejects self as supervisor with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.edit"])
    expect(
      updateRoute.handler(ctx, {
        id: emp.id,
        supervisorId: emp.id,
      })
    ).rejects.toThrow("An employee cannot be their own supervisor")
  })

  test("rejects self as HR manager with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.edit"])
    expect(
      updateRoute.handler(ctx, {
        id: emp.id,
        hrManagerId: emp.id,
      })
    ).rejects.toThrow("An employee cannot be their own HR manager")
  })

  test("rejects invalid personal email format with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.edit"])
    expect(
      updateRoute.handler(ctx, {
        id: emp.id,
        personalEmail: "not-an-email",
      })
    ).rejects.toThrow("Invalid personal email address format")
  })

  test("rejects cross-tenant foreign branch with 400", async () => {
    const foreignBranch = await db.branch.create({
      data: {
        vendorId: foreignVendor.id,
        name: "Foreign Branch",
        code: `FBR-${Date.now()}`,
      },
    })
    const ctx = makeCtx(hrAdmin, ["employees.edit"])
    expect(
      updateRoute.handler(ctx, {
        id: emp.id,
        branchId: foreignBranch.id,
      })
    ).rejects.toThrow("Selected branch does not belong to your organization")
  })

  test("successfully updates employee across all 8 groups with valid payload", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.edit", "bankInfo.edit"])

    // Create valid tenant branch and department
    const branch = await db.branch.create({
      data: {
        vendorId: vendor.id,
        name: "Dhaka Central Branch",
        code: `BR-${Date.now()}`,
      },
    })
    const dept = await db.department.create({
      data: {
        vendorId: vendor.id,
        name: "Engineering & QA",
        code: `DEP-${Date.now()}`,
      },
    })

    const updated = (await updateRoute.handler(ctx, {
      id: emp.id,
      fullName: "Kamal Hossain Chowdhury",
      preferredName: "Kamal",
      nameBn: "কামাল হোসেন চৌধুরী",
      fatherName: "Abul Hossain",
      motherName: "Fatema Begum",
      dob: "1991-08-14",
      gender: "MALE",
      bloodGroup: "O+",
      maritalStatus: "MARRIED",
      religion: "ISLAM",
      nationality: "Bangladeshi",
      identityType: "NID",
      identityNumber: "19911234567890123",
      mobile: "+880 1711-223344",
      personalEmail: "kamal.chowdhury@gmail.com",
      officialEmail: "kamal@finixtech.com",
      emergencyName: "Fatema Begum",
      emergencyMobile: "+880 1711-998877",
      emergencyRelation: "Mother",
      permanentAddress: "House 15, Road 2, Dhanmondi, Dhaka",
      presentAddress: "House 15, Road 2, Dhanmondi, Dhaka",
      branchId: branch.id,
      departmentId: dept.id,
      reportingManagerId: managerEmp.id,
      joiningDate: "2022-01-15",
      confirmationDate: "2022-04-15",
      probationMonths: 3,
      employmentType: "PERMANENT",
      status: "ACTIVE",
      category: "Management Staff",
      weeklyOff: "FRIDAY,SATURDAY",
      otEligible: true,
      taxTin: "123456789012",
      previousEmployerIncome: 50000,
      taxAlreadyDeducted: 5000,
    })) as any

    expect(updated).toBeDefined()
    expect(updated.fullName).toBe("Kamal Hossain Chowdhury")
    expect(updated.preferredName).toBe("Kamal")
    expect(updated.branchId).toBe(branch.id)
    expect(updated.departmentId).toBe(dept.id)
    expect(updated.reportingManagerId).toBe(managerEmp.id)
    expect(updated.weeklyOff).toBe("FRIDAY,SATURDAY")
    expect(updated.taxTin).toBe("123456789012")

    // Check identity document was upserted — F28 (P6): raw row encrypted at rest
    const doc = await db.employeeDocument.findFirst({
      where: { vendorId: vendor.id, employeeId: emp.id, category: "IDENTITY" },
    })
    expect(doc).toBeDefined()
    expect(doc?.docNumber?.startsWith("enc::")).toBe(true)
    expect(readPiiText(doc?.docNumber)).toBe("19911234567890123")
    expect(doc?.docType).toBe("NID")
  })
})

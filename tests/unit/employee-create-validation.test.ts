/// <reference types="bun-types" />
// ============ Employee Create Form UX/UI & Validation Tests ============
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { readPiiText } from "@/hrm-server/pii-field"
import { mkVendor, mkUser, makeCtx } from "./_fixtures"
import { validateEmployeeCreateForm, CREATE_FORM_SECTIONS, type CreateSectionKey } from "@/hrm/views/employee-create-dialog"

let vendor: { id: string; name: string }
let foreignVendor: { id: string }
let hrAdmin: any

beforeAll(async () => {
  vendor = await mkVendor("Finix Technologies PLC")
  foreignVendor = await mkVendor("Cross Vendor International")

  hrAdmin = await mkUser(vendor.id, {
    permissions: ["employees.create", "employees.view", "payroll.edit", "bankInfo.edit"],
  })
})

describe("Client-side Form Validation — validateEmployeeCreateForm", () => {
  test("CREATE_FORM_SECTIONS metadata defines all 8 logical groups with icons and numbers", () => {
    expect(CREATE_FORM_SECTIONS.length).toBe(8)
    const expectedIds: CreateSectionKey[] = ["basic", "personal", "identity", "address", "organization", "lifecycle", "attendance", "compensation"]
    expect(CREATE_FORM_SECTIONS.map((s) => s.id)).toEqual(expectedIds)
    CREATE_FORM_SECTIONS.forEach((sec, idx) => {
      expect(sec.number).toBe(idx + 1)
      expect(sec.title).toBeTruthy()
      expect(sec.icon).toBeTruthy()
    })
  })

  test("Group 1: Basic Information — enforces required full name with minimum 2 characters", () => {
    const emptyRes = validateEmployeeCreateForm({ fullName: "" })
    expect(emptyRes.isValid).toBe(false)
    expect(emptyRes.errors.fullName).toBe("Full Name is required")
    expect(emptyRes.sectionErrors.basic).toBe(1)
    expect(emptyRes.firstInvalidSection).toBe("basic")

    const shortRes = validateEmployeeCreateForm({ fullName: "M" })
    expect(shortRes.isValid).toBe(false)
    expect(shortRes.errors.fullName).toBe("Full Name must be at least 2 characters")
  })

  test("Group 2: Personal & Family Information — enforces required DOB, non-future check, gender, and marital status", () => {
    const missingDob = validateEmployeeCreateForm({ fullName: "Mahmud Hasan", dob: "" })
    expect(missingDob.errors.dob).toBe("Date of Birth is required")
    expect(missingDob.sectionErrors.personal).toBeGreaterThanOrEqual(1)

    const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10)
    const futureDob = validateEmployeeCreateForm({ fullName: "Mahmud Hasan", dob: tomorrow })
    expect(futureDob.errors.dob).toBe("Date of birth cannot be in the future")

    // Under-age check (< 14 years old under Bangladesh labor law)
    const childDob = new Date(Date.now() - 365.25 * 24 * 3600 * 1000 * 12).toISOString().slice(0, 10)
    const childRes = validateEmployeeCreateForm({ fullName: "Mahmud Hasan", dob: childDob })
    expect(childRes.errors.dob).toContain("at least 14 years old")

    const noGenderNoMarital = validateEmployeeCreateForm({ fullName: "Mahmud Hasan", dob: "1994-03-12", gender: "", maritalStatus: "" })
    expect(noGenderNoMarital.errors.gender).toBe("Gender selection is required")
    expect(noGenderNoMarital.errors.maritalStatus).toBe("Marital status selection is required")
  })

  test("Group 3: Identity & Contacts — validates email regex, mobile phone digits, and NID", () => {
    const badEmailRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      gender: "MALE",
      maritalStatus: "SINGLE",
      personalEmail: "invalid-email-string",
      officialEmail: "missing-domain@",
      mobile: "123", // too short
    })
    expect(badEmailRes.errors.personalEmail).toBe("Invalid personal email address format")
    expect(badEmailRes.errors.officialEmail).toBe("Invalid official email address format")
    expect(badEmailRes.errors.mobile).toBe("Personal mobile must contain 8 to 15 digits")
    expect(badEmailRes.sectionErrors.identity).toBe(3)

    // NID validation
    const badNidRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      identityType: "NID",
      identityNumber: "12345", // invalid length
    })
    expect(badNidRes.errors.identityNumber).toBe("NID must be 10, 13 or 17 digits")

    // Valid 10-digit NID passes
    const validNidRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      gender: "MALE",
      maritalStatus: "SINGLE",
      identityType: "NID",
      identityNumber: "1994123456",
      personalEmail: "mahmud@example.com",
    })
    expect(validNidRes.sectionErrors.identity).toBe(0)
  })

  test("Group 5: Organizational & Job — requires Branch, Department, and Designation", () => {
    const missingOrgRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      branchId: "",
      departmentId: "",
      designationId: "",
    })
    expect(missingOrgRes.errors.branchId).toBe("Branch is required")
    expect(missingOrgRes.errors.departmentId).toBe("Department is required")
    expect(missingOrgRes.errors.designationId).toBe("Designation is required")
    expect(missingOrgRes.sectionErrors.organization).toBe(3)
  })

  test("Group 6: Employment & Lifecycle — enforces confirmationDate >= joiningDate and contractEnd >= contractStart", () => {
    const missingJoinRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      joiningDate: "",
    })
    expect(missingJoinRes.errors.joiningDate).toBe("Joining Date is required")

    const badConfRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      joiningDate: "2024-05-01",
      confirmationDate: "2024-02-01", // earlier
    })
    expect(badConfRes.errors.confirmationDate).toBe("Confirmation date cannot precede joining date")

    const badContractRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      joiningDate: "2024-05-01",
      contractStart: "2024-05-01",
      contractEnd: "2024-01-01", // earlier
    })
    expect(badContractRes.errors.contractEnd).toBe("Contract end date cannot precede contract start date")
  })

  test("Group 8: Compensation, Tax & Initial Structure — validates e-TIN, salary numbers and payout credentials", () => {
    const badCompRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      taxTin: "123", // invalid
      basic: -5000, // negative
      payoutMethod: "BANK",
      payoutAccountNumber: "", // missing
    })
    expect(badCompRes.errors.taxTin).toBe("e-TIN must be 12 digits")
    expect(badCompRes.errors.basic).toBe("Amount must be a non-negative number")
    expect(badCompRes.errors.payoutAccountNumber).toBe("Account number is required when payout method is Bank")

    const badMfsRes = validateEmployeeCreateForm({
      fullName: "Mahmud Hasan",
      dob: "1994-03-12",
      payoutMethod: "MFS",
      payoutMfsNumber: "123", // too short
    })
    expect(badMfsRes.errors.payoutMfsNumber).toBe("MFS mobile number must be 11 to 14 digits")
  })
})

describe("Server-Side Authoritative Validation — employees.createWithStructure", () => {
  const createRoute = getRoute("employees.createWithStructure")!

  test("rejects future date of birth with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.create", "payroll.edit"])
    const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10)
    expect(
      createRoute.handler(ctx, {
        fullName: "Server Test Employee",
        dob: tomorrow,
        joiningDate: "2024-01-01",
      })
    ).rejects.toThrow("Date of birth cannot be in the future")
  })

  test("rejects confirmationDate preceding joiningDate with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.create", "payroll.edit"])
    expect(
      createRoute.handler(ctx, {
        fullName: "Server Test Employee",
        dob: "1992-05-01",
        joiningDate: "2024-05-01",
        confirmationDate: "2024-01-01",
      })
    ).rejects.toThrow("Confirmation date cannot precede joining date")
  })

  test("rejects contractEnd preceding contractStart with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.create", "payroll.edit"])
    expect(
      createRoute.handler(ctx, {
        fullName: "Server Test Employee",
        dob: "1992-05-01",
        joiningDate: "2024-05-01",
        contractStart: "2024-05-01",
        contractEnd: "2024-02-01",
      })
    ).rejects.toThrow("Contract end date cannot precede contract start date")
  })

  test("rejects invalid personal email format with 400", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.create", "payroll.edit"])
    expect(
      createRoute.handler(ctx, {
        fullName: "Server Test Employee",
        dob: "1992-05-01",
        joiningDate: "2024-05-01",
        personalEmail: "invalid-email-address",
      })
    ).rejects.toThrow("Invalid personal email address format")
  })

  test("rejects cross-tenant foreign branch with 400", async () => {
    const foreignBranch = await db.branch.create({
      data: {
        vendorId: foreignVendor.id,
        name: "Foreign Branch",
        code: `FBR-C-${Date.now()}`,
      },
    })
    const ctx = makeCtx(hrAdmin, ["employees.create", "payroll.edit"])
    expect(
      createRoute.handler(ctx, {
        fullName: "Server Test Employee",
        dob: "1992-05-01",
        joiningDate: "2024-05-01",
        branchId: foreignBranch.id,
      })
    ).rejects.toThrow("Selected branch does not belong to your organization")
  })

  test("successfully creates employee across all 8 groups with initial salary structure and payout credentials", async () => {
    const ctx = makeCtx(hrAdmin, ["employees.create", "payroll.edit", "bankInfo.edit"])

    // Create valid tenant branch and department
    const branch = await db.branch.create({
      data: {
        vendorId: vendor.id,
        name: "Sylhet Regional Hub",
        code: `BR-S-${Date.now()}`,
      },
    })
    const dept = await db.department.create({
      data: {
        vendorId: vendor.id,
        name: "Operations & Logistics",
        code: `DEP-O-${Date.now()}`,
      },
    })
    const desig = await db.designation.create({
      data: {
        vendorId: vendor.id,
        name: "Senior Logistics Officer",
        code: `DES-L-${Date.now()}`,
      },
    })

    const created = (await createRoute.handler(ctx, {
      fullName: "Anwar Hossain",
      preferredName: "Anwar",
      nameBn: "আনোয়ার হোসেন",
      fatherName: "Mokbul Hossain",
      motherName: "Rokeya Begum",
      dob: "1993-10-25",
      gender: "MALE",
      bloodGroup: "A+",
      maritalStatus: "MARRIED",
      religion: "ISLAM",
      nationality: "Bangladeshi",
      identityType: "NID",
      identityNumber: "19931234567890123",
      mobile: "+880 1712-334455",
      personalEmail: "anwar.hossain@gmail.com",
      officialEmail: "anwar@finixtech.com",
      emergencyName: "Rokeya Begum",
      emergencyMobile: "+880 1712-998877",
      emergencyRelation: "Mother",
      permanentAddress: "Amberkhana, Sylhet",
      presentAddress: "Amberkhana, Sylhet",
      branchId: branch.id,
      departmentId: dept.id,
      designationId: desig.id,
      joiningDate: "2024-01-15",
      confirmationDate: "2024-04-15",
      probationMonths: 3,
      employmentType: "PERMANENT",
      status: "ACTIVE",
      category: "Operations",
      grade: "Grade 5",
      weeklyOff: "FRIDAY,SATURDAY",
      otEligible: true,
      taxTin: "123456789012",
      basic: 30000,
      houseRent: 15000,
      medical: 3000,
      conveyance: 2000,
      payoutMethod: "BANK",
      payoutBank: "City Bank",
      payoutBranch: "Sylhet Main Branch",
      payoutAccountName: "Anwar Hossain",
      payoutAccountNumber: "1234567890123",
      payoutRoutingNumber: "125272654",
    })) as any

    expect(created).toBeDefined()
    expect(created.id).toBeTruthy()
    expect(created.code).toBeTruthy()

    // Verify employee record in database
    const empDb = await db.employee.findUnique({ where: { id: created.id } })
    expect(empDb).toBeDefined()
    expect(empDb?.fullName).toBe("Anwar Hossain")
    expect(empDb?.preferredName).toBe("Anwar")
    expect(empDb?.branchId).toBe(branch.id)
    expect(empDb?.departmentId).toBe(dept.id)
    expect(empDb?.taxTin).toBe("123456789012")

    // Verify initial active salary structure was created atomically
    const salary = await db.salaryStructure.findFirst({
      where: { employeeId: created.id, status: "ACTIVE" },
    })
    expect(salary).toBeDefined()
    expect(salary?.basic).toBe(30000)
    expect(salary?.houseRent).toBe(15000)
    expect(salary?.medical).toBe(3000)
    expect(salary?.conveyance).toBe(2000)
    expect(salary?.gross).toBe(50000)

    // Verify identity document was created — F28 (P6): the raw row is
    // ENCRYPTED at rest; the production read path (readPiiText) recovers it.
    const doc = await db.employeeDocument.findFirst({
      where: { vendorId: vendor.id, employeeId: created.id, category: "IDENTITY" },
    })
    expect(doc).toBeDefined()
    expect(doc?.docNumber?.startsWith("enc::")).toBe(true)
    expect(readPiiText(doc?.docNumber)).toBe("19931234567890123")
    expect(doc?.docType).toBe("NID")
  })
})

/// <reference types="bun-types" />
// ============ TEST-01 (R7) — E2E bootstrap: minimal tenant for HTTP journeys ============
// Run against the FRESH scratch database (scripts/e2e.sh migrates it first):
//   DATABASE_URL=... bun run tests/e2e/_bootstrap.ts
// Creates the smallest tenant the critical journeys need: owner + HR admin +
// one employee with an ESS account, org anchors, a shift, salary structure,
// leave type + balance, and the LEAVE / SALARY_RUN approval workflows.
import { PrismaClient } from "@prisma/client"
import { hashPassword } from "../../src/hrm-server/auth"

const db = new PrismaClient()
const PASSWORD = process.env.E2E_PASSWORD || "E2ePass@123"

async function main() {
  const vendor = await db.vendor.create({ data: { name: "E2E Journeys Ltd", code: `E2E-${Date.now().toString(36).slice(-4).toUpperCase()}` } })

  const owner = await db.user.create({
    data: { vendorId: vendor.id, name: "E2E Owner", email: "owner@e2e.local", passwordHash: hashPassword(PASSWORD), role: "VENDOR_OWNER", permissions: JSON.stringify(["*"]) },
  })
  // the E2E tenant runs without TOTP: an explicit Role row (mfaRequired=false)
  // disables the VENDOR_OWNER/HR_ADMIN MFA-enrollment default so the journeys
  // exercise the password → session → CSRF path directly
  await db.role.create({ data: { vendorId: vendor.id, key: "HR_ADMIN", name: "HR Admin", permissions: JSON.stringify(["*"]), mfaRequired: false } })
  await db.role.create({ data: { vendorId: vendor.id, key: "VENDOR_OWNER", name: "Owner", permissions: JSON.stringify(["*"]), mfaRequired: false } })
  const hr = await db.user.create({
    data: { vendorId: vendor.id, name: "E2E HR", email: "hr@e2e.local", passwordHash: hashPassword(PASSWORD), role: "HR_ADMIN", permissions: JSON.stringify(["*"]) },
  })

  const branch = await db.branch.create({ data: { vendorId: vendor.id, name: "E2E HQ", code: "HQ" } })
  const designation = await db.designation.create({ data: { vendorId: vendor.id, name: "Engineer", code: "ENG" } })
  const shift = await db.shift.create({ data: { vendorId: vendor.id, name: "Day Shift", startTime: "09:00", endTime: "17:00", graceMinutes: 10, breakMinutes: 60, weeklyOff: "FRIDAY" } as any })

  const employee = await db.employee.create({
    data: {
      vendorId: vendor.id, fullName: "Journey Employee", code: "E2E-001",
      branchId: branch.id, designationId: designation.id, shiftId: shift.id,
      joiningDate: "2025-01-01", employmentType: "PERMANENT", status: "ACTIVE", weeklyOff: "FRIDAY",
    },
  })
  const ess = await db.user.create({
    data: { vendorId: vendor.id, name: "Journey Employee", email: "employee@e2e.local", passwordHash: hashPassword(PASSWORD), role: "EMPLOYEE", permissions: JSON.stringify(["ess.view", "ess.create", "ess.edit", "ess.download"]), employeeId: employee.id },
  })

  // payout configuration (payroll.pay validates: above ৳10,000 needs BANK)
  const bankAccount = await db.bankAccount.create({
    data: { vendorId: vendor.id, employeeId: employee.id, holderName: "Journey Employee", bank: "E2E Bank", branch: "Gulshan", accountNumber: "1234567890", routingNumber: "090260152", accountType: "SALARY", paymentMethod: "BANK", isPrimary: true, verified: true } as any,
  })
  await db.employee.update({ where: { id: employee.id }, data: { salaryPayoutMethod: "BANK", salaryPayoutAccountId: bankAccount.id } as any })

  // salary structure (ACTIVE — payroll picks it up)
  await db.salaryStructure.create({
    data: {
      vendorId: vendor.id, employeeId: employee.id, status: "ACTIVE", effectiveFrom: "2025-01-01",
      basic: 30000, houseRent: 12000, medical: 3000, conveyance: 2000,
      gross: 47000,
    } as any,
  })

  // leave type + balance + the LEAVE approval workflow
  const leaveType = await db.leaveType.create({
    data: { vendorId: vendor.id, code: "CASUAL", name: "Casual Leave", paid: true, defaultDays: 10, waitingPeriodDays: 0, probationEligible: true, active: true, maxConsecutiveDays: 3 },
  })
  await db.leaveBalance.create({ data: { vendorId: vendor.id, employeeId: employee.id, leaveTypeId: leaveType.id, year: new Date().getFullYear(), entitled: 10, used: 0, pending: 0, carriedForward: 0 } })
  const leaveWf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, processType: "LEAVE", name: "Leave Approval", active: true } })
  await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: leaveWf.id, sequence: 1, name: "HR", approverRole: "HR_ADMIN", required: true } })
  const salaryWf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, processType: "PAYROLL", name: "Payroll Approval", active: true } })
  await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: salaryWf.id, sequence: 1, name: "Owner Approver", approverRole: "VENDOR_OWNER", required: true } })

  console.log(JSON.stringify({
    ok: true,
    vendorId: vendor.id,
    ownerEmail: owner.email, hrEmail: hr.email, essEmail: ess.email,
    employeeId: employee.id, leaveTypeId: leaveType.id, password: PASSWORD,
  }))
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())

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

  // OPS-5 (P2 wave) — the multi-company wave made company context MANDATORY
  // (payroll.runs.create / approvals.queue / most mutating routes Deny with
  // "No active company" when the session cannot resolve one). The bootstrap
  // used to create a bare vendor, which silently rotted the whole e2e lane.
  // Every bootstrap tenant now gets the default company + access rows.
  const company = await db.company.create({
    data: { vendorId: vendor.id, code: "MAIN", name: "E2E Journeys Ltd", active: true, isDefault: true },
  })

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
  // OPS-5 — default-company access so sessions resolve activeCompanyId
  // (the ESS user resolves the employee's company at request time)
  for (const [u, role] of [[owner, "VENDOR_OWNER"], [hr, "HR_ADMIN"]] as const) {
    await db.userCompanyAccess.create({
      data: { vendorId: vendor.id, userId: u.id, companyId: company.id, role, permissions: "[]", excludedPermissions: "[]", active: true, isDefault: true },
    })
  }

  const branch = await db.branch.create({
    data: {
      vendorId: vendor.id, companyId: company.id, name: "E2E HQ", code: "HQ",
      // TST-1 (P2 wave) — geofence for the login-to-punch UI smoke: the
      // Playwright context supplies the matching coordinates (Dhaka center,
      // 300 m radius), so the Geo Check-In quick action records a real punch.
      latitude: 23.7808, longitude: 90.4142, geofenceRadius: 300, geofenceActive: true,
    } as any,
  })
  const designation = await db.designation.create({ data: { vendorId: vendor.id, name: "Engineer", code: "ENG" } })
  const shift = await db.shift.create({ data: { vendorId: vendor.id, name: "Day Shift", startTime: "09:00", endTime: "17:00", graceMinutes: 10, breakMinutes: 60, weeklyOff: "FRIDAY" } as any })

  const employee = await db.employee.create({
    data: {
      vendorId: vendor.id, companyId: company.id, fullName: "Journey Employee", code: "E2E-001",
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
    // companyId — MULTI-COMPANY: the ESS apply path resolves leave types
    // within the employee's active company (a null-company type is invisible)
    data: { vendorId: vendor.id, companyId: company.id, code: "CASUAL", name: "Casual Leave", paid: true, defaultDays: 10, waitingPeriodDays: 0, probationEligible: true, active: true, maxConsecutiveDays: 3 },
  })
  await db.leaveBalance.create({ data: { vendorId: vendor.id, employeeId: employee.id, leaveTypeId: leaveType.id, year: new Date().getFullYear(), entitled: 10, used: 0, pending: 0, carriedForward: 0 } })
  const leaveWf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, processType: "LEAVE", name: "Leave Approval", active: true } })
  await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: leaveWf.id, sequence: 1, name: "HR", approverRole: "HR_ADMIN", required: true } })
  const salaryWf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, processType: "PAYROLL", name: "Payroll Approval", active: true } })
  await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: salaryWf.id, sequence: 1, name: "Owner Approver", approverRole: "VENDOR_OWNER", required: true } })

  // FORENSIC AUDIT 2026-11-10, FIN-004 (Phase 1) — the company-switch e2e lane
  // (tests/e2e-ui/company-switch.spec.ts): a SECOND company with its own
  // employee plus owner access to both. Inert for every existing journey —
  // they pin the default company's fixtures and never list companies.
  const companyB = await db.company.create({
    data: { vendorId: vendor.id, code: "SECOND", name: "E2E Second Company Ltd", active: true },
  })
  await db.userCompanyAccess.create({
    data: { vendorId: vendor.id, userId: owner.id, companyId: companyB.id, role: "VENDOR_OWNER", active: true },
  })
  await db.employee.create({
    data: { vendorId: vendor.id, companyId: companyB.id, fullName: "E2E SecondCo Employee", code: "E2E-B-0001", joiningDate: "2025-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
  })

  // FORENSIC AUDIT 2026-11-10, FIN-015 (Phase 2) — pager e2e fixture: 18
  // catalogue items so the Inventory items list (DataTable, pageSize 15)
  // carries a second page. Inert for every existing journey — none of them
  // lists catalogue items or counts them.
  await db.item.createMany({
    data: Array.from({ length: 18 }, (_, i) => ({
      vendorId: vendor.id, companyId: company.id,
      code: `E2E-ITM-${String(i + 1).padStart(4, "0")}`,
      name: `E2E Pager Item ${i + 1}`,
      category: "OTHER", unit: "Pcs", active: true,
    })),
  })

  console.log(JSON.stringify({
    ok: true,
    vendorId: vendor.id,
    ownerEmail: owner.email, hrEmail: hr.email, essEmail: ess.email,
    employeeId: employee.id, leaveTypeId: leaveType.id, password: PASSWORD,
  }))
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())

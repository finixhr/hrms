// ============ GET /api/v1/employees/[id] — public REST API (employees:read) =
// Single employee (same directory-level field policy as the list route) plus
// the CURRENT salary structure summary (components + gross; never payout
// account details — those are bankInfo-gated in the app itself).
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { authenticateRequest, apiOk, apiErr, auditApiRequest } from "../../_auth"

export const dynamic = "force-dynamic"

const EMPLOYEE_API_SELECT = {
  id: true, code: true, fullName: true, nameBn: true, preferredName: true,
  gender: true, bloodGroup: true, maritalStatus: true, nationality: true, religion: true,
  dob: true, mobile: true, altMobile: true, officialEmail: true, personalEmail: true,
  branchId: true, departmentId: true, designationId: true, reportingManagerId: true,
  workLocation: true, joiningDate: true, confirmationDate: true, probationMonths: true,
  employmentType: true, status: true, category: true, grade: true,
  createdAt: true, updatedAt: true,
} as const

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(req, "employees:read")
  if (!auth.ok) return auth.res
  const { key, ip } = auth
  const { id } = await params

  const emp = await db.employee.findFirst({ where: { vendorId: key.vendorId, id }, select: EMPLOYEE_API_SELECT })
  if (!emp) return apiErr(404, "NOT_FOUND", "Employee not found")

  const [branch, dept, desig, manager, structure] = await Promise.all([
    emp.branchId ? db.branch.findFirst({ where: { vendorId: key.vendorId, id: emp.branchId }, select: { id: true, name: true } }) : null,
    emp.departmentId ? db.department.findFirst({ where: { vendorId: key.vendorId, id: emp.departmentId }, select: { id: true, name: true } }) : null,
    emp.designationId ? db.designation.findFirst({ where: { vendorId: key.vendorId, id: emp.designationId }, select: { id: true, name: true } }) : null,
    emp.reportingManagerId ? db.employee.findFirst({ where: { vendorId: key.vendorId, id: emp.reportingManagerId }, select: { id: true, fullName: true } }) : null,
    db.salaryStructure.findFirst({
      where: { vendorId: key.vendorId, employeeId: emp.id, status: "ACTIVE" },
      orderBy: { effectiveFrom: "desc" },
      select: {
        id: true, effectiveFrom: true, effectiveTo: true, status: true,
        basic: true, houseRent: true, medical: true, conveyance: true, food: true,
        mobileAllow: true, internetAllow: true, attendanceAllow: true, otherAllowance: true,
        gross: true, componentsJson: true,
      },
    }),
  ])

  await auditApiRequest(key, ip, "Employee", emp.id, `GET /api/v1/employees/${id}`)
  let extraComponents: unknown = []
  try {
    const v = JSON.parse(structure?.componentsJson || "[]")
    if (Array.isArray(v)) extraComponents = v
  } catch { /* corrupt componentsJson → empty */ }
  return apiOk({
    employee: {
      ...emp,
      branchName: branch?.name ?? null,
      departmentName: dept?.name ?? null,
      designationName: desig?.name ?? null,
      reportingManagerName: manager?.fullName ?? null,
    },
    structureSummary: structure
      ? {
          id: structure.id,
          effectiveFrom: structure.effectiveFrom,
          effectiveTo: structure.effectiveTo,
          status: structure.status,
          components: {
            basic: structure.basic,
            houseRent: structure.houseRent,
            medical: structure.medical,
            conveyance: structure.conveyance,
            food: structure.food,
            mobileAllow: structure.mobileAllow,
            internetAllow: structure.internetAllow,
            attendanceAllow: structure.attendanceAllow,
            otherAllowance: structure.otherAllowance,
          },
          gross: structure.gross,
          extraComponents,
        }
      : null,
  })
}

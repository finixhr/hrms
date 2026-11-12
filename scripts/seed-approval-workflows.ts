// ============ Seed missing approval workflows (idempotent) ============
// User report: "Many Approval Workflow is missing." Root causes:
//   1. OVERTIME and ENCASHMENT process types are used by the app (roadmap
//      overtime requests, leave encashment) but were never seeded — submissions
//      fail with "No approval workflow configured".
//   2. GOODS_REQUISITION / PURCHASE / OVERTIME / ENCASHMENT were absent from
//      the Settings → Approval Workflows UI list, so users could not even see
//      or create them.
// This script walks EVERY vendor and EVERY engine process type and creates a
// sensible default workflow whenever one is missing. Safe to re-run.
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

type StepDef = { name: string; approverRole?: string; departmentScope?: boolean; branchScope?: boolean; amountThreshold?: number }

const DEFAULTS: Record<string, { name: string; steps: StepDef[]; simpleSteps: StepDef[] }> = {
  LEAVE: { name: "Leave Approval", steps: [{ name: "Supervisor / Manager", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "HR Review", approverRole: "HR_MANAGER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  LOAN: { name: "Loan Approval", steps: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true, amountThreshold: 50000 }, { name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  ADVANCE: { name: "Advance Approval", steps: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true, amountThreshold: 20000 }, { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  EXPENSE: { name: "Expense Approval", steps: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  PAYROLL: { name: "Payroll Approval", steps: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Manager Approval", approverRole: "HR_ADMIN" }, { name: "Finance / Accounting Approval", approverRole: "PAYROLL_OFFICER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  LETTER: { name: "HR Letter Approval", steps: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management Approval", approverRole: "HR_ADMIN" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  RESIGNATION: { name: "Resignation Approval", steps: [{ name: "Reporting Manager", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "Department Head", approverRole: "DEPT_MANAGER" }, { name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management", approverRole: "HR_ADMIN" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  PROMOTION: { name: "Promotion Approval", steps: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management Approval", approverRole: "HR_ADMIN" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  TRANSFER: { name: "Transfer Approval", steps: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management Approval", approverRole: "HR_ADMIN" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  SALARY_REVISION: { name: "Salary Revision Approval", steps: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management Approval", approverRole: "HR_ADMIN" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  // ── previously-missing types ──
  OVERTIME: { name: "Overtime Approval", steps: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "HR Review", approverRole: "HR_MANAGER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  ENCASHMENT: { name: "Leave Encashment Approval", steps: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  GOODS_REQUISITION: { name: "Goods Requisition Approval", steps: [{ name: "Department Head", approverRole: "DEPT_MANAGER" }, { name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Final Approval", approverRole: "HR_ADMIN" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  PURCHASE: { name: "Purchase Approval", steps: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Owner Approval", approverRole: "VENDOR_OWNER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  ASSET_ISSUE: { name: "Asset Issue Approval", steps: [{ name: "Store / HR Review", approverRole: "HR_MANAGER" }, { name: "Final Approval", approverRole: "HR_ADMIN" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
  // PAY-006 (R3-2) — escalated bonus approval: bonuses at/above
  // Settings → Payroll → Bonus Approval → escalationThreshold ride this
  // workflow instead of direct approval (single or bulk). One owner-level
  // gate sized to the money at stake.
  BONUS: { name: "Bonus Approval (Escalated)", steps: [{ name: "HR / Finance Review", approverRole: "PAYROLL_OFFICER" }, { name: "Owner Approval", approverRole: "VENDOR_OWNER" }], simpleSteps: [{ name: "Owner Approval", approverRole: "VENDOR_OWNER" }] },
}

async function main() {
  const vendors = await db.vendor.findMany()
  let created = 0
  for (const vendor of vendors) {
    // demo/primary vendor gets the full multi-step defaults; minimal vendors get owner-only
    const isPrimary = vendor.code !== "RONGIN"
    for (const [processType, def] of Object.entries(DEFAULTS)) {
      const existing = await db.approvalWorkflow.findFirst({ where: { vendorId: vendor.id, processType } })
      if (existing) continue
      const steps = isPrimary ? def.steps : def.simpleSteps
      const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, processType, name: def.name, active: true } })
      let seq = 1
      for (const s of steps) {
        await db.approvalStep.create({
          data: {
            vendorId: wf.vendorId, workflowId: wf.id, sequence: seq++, name: s.name,
            approverRole: s.approverRole || null, departmentScope: !!s.departmentScope, branchScope: !!s.branchScope,
            amountThreshold: s.amountThreshold ?? null, required: true, rejectBehavior: "REJECT_ALL",
          },
        })
      }
      created++
      console.log(`✓ created ${processType} workflow for ${vendor.code} (${steps.length} steps)`)
    }
  }
  const total = await db.approvalWorkflow.count()
  console.log(`\nDone. Created ${created} workflow(s); ${total} total across ${vendors.length} vendor(s).`)
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })

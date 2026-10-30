// Verify seed data by counting rows in every major table.
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const tables = [
    "vendor", "branch", "department", "designation", "shift", "holiday",
    "approvalWorkflow", "approvalStep", "leaveType", "taxRuleSet", "taxSlab",
    "letterTemplate", "employee", "user", "attendance", "attendanceDevice",
    "attendanceDeviceUser", "attendanceRawEvent", "deviceCommLog", "deviceCommand",
    "leaveRequest", "leaveBalance", "loan", "loanInstallment", "advance",
    "expenseClaim", "salaryStructure", "salaryRevision", "payrollRun", "payrollEntry",
    "hrLetter", "resignation", "exitClearance", "announcement", "companyEvent",
    "notification", "task", "kpiTemplate", "kpiAssignment", "reviewCycle",
    "performanceReview", "auditLog",
  ]
  console.log("════════════════════════════════════════════════════════════════")
  console.log("  SEED DATA VERIFICATION")
  console.log("════════════════════════════════════════════════════════════════")
  let total = 0
  for (const t of tables) {
    const n = await (db as any)[t].count()
    if (n > 0) {
      console.log(`  ${t.padEnd(28)} ${String(n).padStart(6)} rows`)
      total += n
    }
  }
  console.log("  " + "─".repeat(60))
  console.log(`  ${"TOTAL".padEnd(28)} ${String(total).padStart(6)} rows`)
  console.log("════════════════════════════════════════════════════════════════")

  // Show login accounts grouped by vendor
  console.log("\n📋 LOGIN ACCOUNTS")
  const vendors = await db.vendor.findMany({ select: { id: true, name: true } })
  const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name || "—"
  const users = await db.user.findMany({ orderBy: [{ vendorId: "asc" }, { role: "asc" }] })
  const byVendor: Record<string, typeof users> = {}
  for (const u of users) {
    const v = vendorName(u.vendorId)
    if (!byVendor[v]) byVendor[v] = []
    byVendor[v].push(u)
  }
  for (const [vname, list] of Object.entries(byVendor)) {
    console.log(`\n  ${vname}:`)
    for (const u of list) {
      console.log(`    ${u.email.padEnd(36)} ${u.role.padEnd(20)} ${u.name}`)
    }
  }
  console.log("\n  Password for all accounts: Pass@123")

  // Show device summary
  console.log("\n📋 ATTENDANCE DEVICES")
  const branches = await db.branch.findMany({ select: { id: true, name: true } })
  const branchName = (id: string | null) => id ? (branches.find((b) => b.id === id)?.name || "—") : "—"
  const devices = await db.attendanceDevice.findMany()
  for (const d of devices) {
    console.log(`  ${(d.deviceIdentifier || "—").padEnd(20)} ${(d.model || "—").padEnd(20)} ${d.status.padEnd(8)} ${branchName(d.branchId)}`)
  }

  // ---- R3-4/R3-5 wave-demo feature checks (2026-10-17) --------------------
  console.log("\n📋 R3-4 / R3-5 WAVE DEMOS")
  let ok = 0, fail = 0
  const check = (label: string, pass: boolean, detail = "") => {
    console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`)
    if (pass) ok++
    else fail++
  }

  // LVE-005/006/007 — leave encashment lifecycle
  const pendingEncash = await db.approvalRequest.count({ where: { processType: "ENCASHMENT", status: "PENDING" } })
  check("pending leave-encashment approval (EMP-0007)", pendingEncash >= 1, `${pendingEncash} in queue`)
  const encashBonus = await db.bonus.findFirst({ where: { type: "ENCASHMENT", status: "APPROVED" } })
  check("approved ENCASHMENT bonus queued for payroll (EMP-0002)", !!encashBonus, encashBonus ? `৳${encashBonus.amount} — ${encashBonus.label}` : "none")

  // LOA-001/002 — overdue installments + arrears loan
  const overdueInst = await db.loanInstallment.count({ where: { status: "OVERDUE" } })
  check("OVERDUE loan installments (EMP-0016 arrears demo)", overdueInst >= 2, `${overdueInst} overdue`)

  // ADV-001 — recovery-floor advance
  const floorAdv = await db.advance.findFirst({ where: { reason: { contains: "recovery-floor" } } })
  check("advance beyond 50% recovery floor (EMP-0018)", !!floorAdv, floorAdv ? `৳${floorAdv.outstanding} outstanding of ৳${floorAdv.amount}` : "none")

  // LVE-001 — pending UNPAID leave
  const unpaidType = await db.leaveType.findFirst({ where: { code: "UNPAID" } })
  const pendingUnpaid = unpaidType
    ? await db.leaveRequest.count({ where: { leaveTypeId: unpaidType.id, status: "PENDING" } })
    : 0
  check("pending UNPAID-type leave (EMP-0013 → LWP path)", pendingUnpaid >= 1, `${pendingUnpaid} pending`)

  // FLD-103 — field-permission rules
  const fpRoles = await db.hrSetting.findFirst({ where: { group: "fieldPermissions", key: "roles" } })
  const fpDefault = await db.hrSetting.findFirst({ where: { group: "fieldPermissions", key: "default" } })
  let fpDetail = "missing"
  try {
    const roles = fpRoles ? JSON.parse(fpRoles.value) : null
    if (roles) fpDetail = Object.entries(roles).map(([r, g]) => `${r}: ${Object.entries(g as object).map(([k, v]) => `${k}=${v}`).join(", ")}`).join(" | ")
  } catch { /* keep "missing" */ }
  check("field-permission rules seeded (FLD-103)", !!fpRoles && !!fpDefault, fpDetail)

  // WF-001 — aged pending approval for the reminder sweep
  const aged = await db.approvalRequest.findFirst({
    where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - 3 * 86400000) } },
  })
  check("approval aged past reminder threshold (WF-001 sweep)", !!aged, aged ? `${aged.processType} · ${aged.entityRef}` : "none older than 3 days")

  console.log(`\n  ${fail === 0 ? "ALL WAVE-DEMO FIXTURES PRESENT" : `${fail} FIXTURE(S) MISSING`} (${ok}/${ok + fail})`)

  // ---- SaaS layer ----------------------------------------------------------
  console.log("\n📋 SAAS LAYER")
  const plans = await db.saasPlan.findMany({ orderBy: { sortOrder: "asc" } })
  for (const p of plans) {
    console.log(`  ${p.name.padEnd(14)} ৳${p.monthlyPrice}/mo · employees ${p.employeeLimit ?? "∞"} · payroll ${p.payrollEnabled ? "on" : "off"} · tracking ${p.trackingEnabled ? "on" : "off"}`)
  }
  const owner = await db.saasOwnerUser.findFirst({ select: { email: true, roleKey: true } })
  console.log(`  owner console: ${owner?.email || "—"} (${owner?.roleKey || "—"}) → /owner/login`)
  const subs = await db.saasSubscription.findMany({ select: { vendorId: true, planName: true, status: true, endDate: true } })
  for (const s of subs) {
    console.log(`  subscription: ${vendorName(s.vendorId).padEnd(24)} ${s.planName.padEnd(14)} ${s.status} → ${s.endDate?.toISOString().slice(0, 10)}`)
  }
}

main().finally(() => db.$disconnect())

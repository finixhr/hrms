// ============ Verify the clean/production seed (seed:owner) ==================
// Run AFTER `bun run seed:owner` (same DATABASE_URL):
//   DATABASE_URL=... bun run scripts/verify-owner-seed.ts
// Exits non-zero when any check fails. Works against any DB the seed targeted.
import { PrismaClient } from "@prisma/client"
import crypto from "node:crypto"
import { ACTIONS, MODULES } from "../src/hrm-server/types"

const db = new PrismaClient()
const EXPECTED_PASSWORD =
  process.env.HRM_SEED_OWNER_PASSWORD || process.env.HRM_SEED_PASSWORD || "Pass@123"
const OWNER_EMAIL = (process.env.HRM_SEED_OWNER_EMAIL || "owner@finixhr.com").toLowerCase().trim()

const ALL = MODULES.flatMap((m) => ACTIONS.map((a) => `${m}.${a}`))
let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} — ${label}${detail ? ` (${detail})` : ""}`)
  if (!ok) failures++
}

async function main() {
  const vendor = await db.vendor.findFirst({ orderBy: { createdAt: "asc" } })
  check(!!vendor, "vendor exists")
  if (!vendor) return finish()
  console.log(`\nVendor: ${vendor.name} (${vendor.code})\n`)

  // ---- owner account --------------------------------------------------------
  const owner = await db.user.findFirst({ where: { vendorId: vendor.id, email: OWNER_EMAIL } })
  check(!!owner, `owner account ${OWNER_EMAIL} exists`)
  if (owner) {
    check(owner.role === "VENDOR_OWNER", "owner role is VENDOR_OWNER")
    check(owner.status === "ACTIVE", "owner status ACTIVE")
    check(!owner.employeeId, "owner not tied to a dummy employee record")
    const perms = JSON.parse(owner.permissions || "[]") as string[]
    check(perms.length === ALL.length, `all ${ALL.length} permissions granted`, `got ${perms.length}`)
    const missing = ALL.filter((p) => !perms.includes(p))
    check(missing.length === 0, "no missing module.action grants", missing.slice(0, 5).join(", "))
    const extra = perms.filter((p) => !ALL.includes(p))
    check(extra.length === 0, "no unknown permission keys", extra.slice(0, 5).join(", "))
    // password verifies (same scrypt scheme as hrm-server/auth.ts hashPassword)
    const [salt, hash] = String(owner.passwordHash || "").split(":")
    const ok = !!salt && !!hash &&
      crypto.scryptSync(EXPECTED_PASSWORD, salt, 64).toString("hex") === hash
    check(ok, `password verifies against seed password`)
  }

  const userTotal = await db.user.count({ where: { vendorId: vendor.id } })
  check(userTotal === 1, "exactly ONE user account (no demo users)", `got ${userTotal}`)

  // ---- approval workflows (access flows) --------------------------------------
  const PROCESS_TYPES = [
    "LEAVE", "LOAN", "ADVANCE", "EXPENSE", "PAYROLL", "LETTER", "RESIGNATION",
    "PROMOTION", "TRANSFER", "SALARY_REVISION", "OVERTIME", "ENCASHMENT",
    "GOODS_REQUISITION", "PURCHASE",
  ]
  const wfs = await db.approvalWorkflow.findMany({ where: { vendorId: vendor.id } })
  check(wfs.length === 14, "14/14 approval workflows configured", `got ${wfs.length}`)
  const missingTypes = PROCESS_TYPES.filter((t) => !wfs.some((w) => w.processType === t))
  check(missingTypes.length === 0, "no missing process types", missingTypes.join(", "))
  check(wfs.every((w) => w.active), "all workflows active")
  const steps = await db.approvalStep.findMany({
    where: { workflowId: { in: wfs.map((w) => w.id) } },
  })
  check(wfs.every((w) => steps.some((s) => s.workflowId === w.id)),
    "every workflow has at least one step")
  check(steps.length > 0 && steps.every((s) => s.approverRole === "VENDOR_OWNER"),
    "steps route to the owner (VENDOR_OWNER)")

  // ---- statutory configuration (kept, it is config — not demo data) ----------
  // LVE-113 (R7) — 7 types: the EARNED duplicate is gone (ANNUAL carries the
  // earned-leave quota), SICK requires attachments, CASUAL is capped at 3-day runs.
  const lt = await db.leaveType.count({ where: { vendorId: vendor.id } })
  check(lt === 7, "7 statutory leave types (LVE-113: EARNED duplicate removed)", `got ${lt}`)
  const fy = await db.aitFiscalYear.findFirst({ where: { vendorId: vendor.id, active: true } })
  check(!!fy, "AIT fiscal-year config active", fy ? fy.label : "none")
  if (fy) {
    const [cats, slabs] = await Promise.all([
      db.aitTaxpayerCategory.count({ where: { fiscalYearId: fy.id } }),
      db.aitTaxSlab.count({ where: { fiscalYearId: fy.id } }),
    ])
    check(cats >= 5, "AIT taxpayer categories", `got ${cats}`)
    check(slabs >= 5, "AIT tax slabs", `got ${slabs}`)
  }

  // ---- NO dummy data ---------------------------------------------------------
  console.log("\nDummy data (all must be zero):")
  const dummy: [string, unknown][] = [
    ["employees", await db.employee.count({ where: { vendorId: vendor.id } })],
    ["attendance", await db.attendance.count({ where: { vendorId: vendor.id } })],
    ["payroll runs", await db.payrollRun.count({ where: { vendorId: vendor.id } })],
    ["loans", await db.loan.count({ where: { vendorId: vendor.id } })],
    ["leave requests", await db.leaveRequest.count({ where: { vendorId: vendor.id } })],
    ["devices", await db.attendanceDevice.count({ where: { vendorId: vendor.id } })],
    ["branches", await db.branch.count({ where: { vendorId: vendor.id } })],
    ["departments", await db.department.count({ where: { vendorId: vendor.id } })],
    ["salary structures", await db.salaryStructure.count({ where: { vendorId: vendor.id } })],
    ["inventory items", await db.item.count({ where: { vendorId: vendor.id } })],
    ["stock entries", await db.stockEntry.count({ where: { vendorId: vendor.id } })],
    ["HR letters", await db.hrLetter.count({ where: { vendorId: vendor.id } })],
    ["notifications", await db.notification.count({ where: { vendorId: vendor.id } })],
    ["audit log rows", await db.auditLog.count({ where: { vendorId: vendor.id } })],
    ["sessions", await db.session.count()],
    ["approval requests", await db.approvalRequest.count({ where: { vendorId: vendor.id } })],
  ]
  for (const [label, n] of dummy) check(Number(n) === 0, `${label} = 0`, `got ${n}`)

  await finish()
}

async function finish() {
  console.log("")
  if (failures) {
    console.error(`✗ verify-owner-seed: ${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log("✓ verify-owner-seed: all checks passed — clean owner-only tenant")
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })

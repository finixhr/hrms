// ============ Finix HR — CLEAN / PRODUCTION seed ============
// The opposite of src/hrm-server/seed.ts (the huge TEST corpus): this seed
// bootstraps a FRESH tenant with NO dummy data.
//
// Creates ONLY:
//   1. One vendor (company) record                       — env-configurable
//   2. ONE owner account (role VENDOR_OWNER) with EVERY
//      module.action permission (MODULES × ACTIONS, computed from the app's
//      own constants — always in sync, no hard-coded list to rot)
//   3. All 14 approval workflows ("access flows") — LEAVE, LOAN, ADVANCE,
//      EXPENSE, PAYROLL, LETTER, RESIGNATION, PROMOTION, TRANSFER,
//      SALARY_REVISION, OVERTIME, ENCASHMENT, GOODS_REQUISITION, PURCHASE —
//      each with a single "Owner Approval" step so a one-user organization is
//      immediately functional; add steps in Settings → Approval Workflows as
//      HR/finance staff are hired (the owner is a super-approver regardless)
//   4. Statutory Bangladesh configuration (config, NOT demo data):
//      - AIT FY 2025-26 fiscal-year config via the engine's own
//        ensureAitConfig() bootstrap — Payroll AIT cannot run without it
//      - The 8 statutory leave types with BD-standard policies
//
// Deliberately NOT created (dummy/demo data lives in the full seed only):
//   demo employees/users for every role, organization trees, shifts,
//   attendance history, biometric devices, payroll runs/payslips, loans,
//   KPIs, letters, announcements, inventory stock, holidays, letter templates.
//
// Run:  bun run seed:prod       (loads .env.production — recommended)
//       bun run seed:owner       (uses the active .env)
//       HRM_SEED_KEEP_DATA=1 bun run seed:owner   # idempotent add-only (no wipe)
//
// Config (see .env.example):
//   HRM_SEED_VENDOR_NAME / HRM_SEED_VENDOR_CODE / HRM_SEED_VENDOR_LEGAL_NAME
//   HRM_SEED_VENDOR_ADDRESS / HRM_SEED_VENDOR_PHONE / HRM_SEED_VENDOR_EMAIL
//   HRM_SEED_OWNER_EMAIL / HRM_SEED_OWNER_NAME / HRM_SEED_OWNER_PHONE
//   HRM_SEED_OWNER_PASSWORD (falls back to HRM_SEED_PASSWORD, then "Pass@123")
import { db } from "@/lib/db"
import { hashPassword } from "./auth"
import { ACTIONS, MODULES } from "./types"
import { ensureAitConfig } from "./ait-engine"
import { resetDatabase } from "./seed-reset"

// ---- Every module.action grant that exists in the system --------------------
export const ALL_PERMISSIONS: string[] = MODULES.flatMap((m) =>
  ACTIONS.map((a) => `${m}.${a}`)
)

// All 14 approval-engine process types (schema ApprovalWorkflow.processType).
const PROCESS_TYPES = [
  "LEAVE", "LOAN", "ADVANCE", "EXPENSE", "PAYROLL", "LETTER", "RESIGNATION",
  "PROMOTION", "TRANSFER", "SALARY_REVISION", "OVERTIME", "ENCASHMENT",
  "GOODS_REQUISITION", "PURCHASE",
] as const

// BD statutory leave types with standard policies (Bangladesh Labour Act).
// LVE-113 (R7) — BD-compliant: encashment on ANNUAL (earned) leave only,
// sick leave requires a medical certificate, casual leave capped at 3-day
// consecutive runs, and the EARNED duplicate (18d next to ANNUAL 20d) is
// gone — one annual/earned quota, one type.
const LEAVE_TYPE_DEFS: [string, string, boolean, number, boolean, boolean][] = [
  ["CASUAL", "Casual Leave", true, 10, false, false],
  ["SICK", "Sick Leave", true, 14, false, false],
  ["ANNUAL", "Annual Leave", true, 20, true, true],
  ["EMERGENCY", "Emergency Leave", true, 7, false, false],
  ["MATERNITY", "Maternity Leave", true, 112, false, false],
  ["PATERNITY", "Paternity Leave", true, 7, false, false],
  ["UNPAID", "Unpaid Leave", false, 15, false, false],
]

// LVE-113 (R7) — BD festival/national holiday template seeded for FRESH
// vendors only (any existing holiday row disables the template so tenant
// edits are never overwritten). Fixed-date national days; moon-dependent
// festivals (Eid, Durga Puja) are added per-year by the admin in Settings →
// Time & Attendance → Holidays.
const BD_HOLIDAY_TEMPLATE: [string, string][] = [
  ["02-21", "Language Martyrs Day & International Mother Language Day"],
  ["03-17", "Sheikh Russel Day"],
  ["03-26", "Independence Day"],
  ["04-14", "Bengali New Year (Pohela Boishakh)"],
  ["05-01", "May Day"],
  ["08-15", "National Mourning Day"],
  ["12-16", "Victory Day"],
  ["12-25", "Christmas Day"],
]

// ---- reset: wipe EVERY model, children before parents -----------------------
// Complete for the whole 92-model schema — shared with the TEST seed via
// src/hrm-server/seed-reset.ts so both seeds always wipe the same table list.

async function reset() {
  await resetDatabase(db, "production seed — no dummy data kept")
}

async function main() {
  const keepData = process.env.HRM_SEED_KEEP_DATA === "1"

  // ---- configuration -------------------------------------------------------
  const vendorName = process.env.HRM_SEED_VENDOR_NAME || "Finix HR"
  const vendorCode = (process.env.HRM_SEED_VENDOR_CODE || "FINIX").toUpperCase()
  const ownerEmail = (process.env.HRM_SEED_OWNER_EMAIL || "owner@finixhr.example").toLowerCase().trim()
  const ownerName = process.env.HRM_SEED_OWNER_NAME || "Owner"
  const ownerPhone = process.env.HRM_SEED_OWNER_PHONE || null
  // HIGH-1 (this audit) — production refuse-to-seed guard for the default password.
  const ownerPassword =
    process.env.HRM_SEED_OWNER_PASSWORD || process.env.HRM_SEED_PASSWORD || "Pass@123"
  const PLACEHOLDER_PATTERNS = /^(Pass@123|CHANGE_ME|GENERATE_WITH_|<)/i
  if (process.env.NODE_ENV === "production" && (ownerPassword === "Pass@123" || PLACEHOLDER_PATTERNS.test(ownerPassword))) {
    console.error("[seed:owner] HRM_SEED_OWNER_PASSWORD / HRM_SEED_PASSWORD is the well-known default or a placeholder.")
    console.error("               Refusing to seed the owner superuser in production with a known password.")
    console.error("               Override with a strong password (min 12 chars, mixed case + digits + symbols).")
    process.exit(1)
  }

  if (!keepData) {
    console.log("⚠  RESET MODE — this wipes the entire database and re-seeds a clean tenant.")
    console.log("   (Set HRM_SEED_KEEP_DATA=1 to run add-only without wiping.)")
    await reset()
  }

  // ---- 1. vendor -----------------------------------------------------------
  let vendor = await db.vendor.findFirst({ where: { code: vendorCode } })
  if (!vendor) {
    vendor = await db.vendor.create({
      data: {
        name: vendorName,
        code: vendorCode,
        legalName: process.env.HRM_SEED_VENDOR_LEGAL_NAME || null,
        address: process.env.HRM_SEED_VENDOR_ADDRESS || null,
        phone: process.env.HRM_SEED_VENDOR_PHONE || null,
        email: process.env.HRM_SEED_VENDOR_EMAIL || null,
        active: true,
      },
    })
    console.log(`✓ vendor "${vendor.name}" (${vendor.code}) created`)
  } else {
    console.log(`• vendor "${vendor.name}" (${vendor.code}) already exists — reused`)
  }

  // ---- 2. owner account with ALL permissions --------------------------------
  const existingOwner = await db.user.findFirst({ where: { vendorId: vendor.id, email: ownerEmail } })
  if (existingOwner) {
    // keep-data re-run: refresh role/status/permissions so the owner is always
    // fully privileged even after new modules were added to the app
    await db.user.update({
      where: { id: existingOwner.id },
      data: {
        role: "VENDOR_OWNER",
        status: "ACTIVE",
        permissions: JSON.stringify(ALL_PERMISSIONS),
        ...(ownerPhone ? { phone: ownerPhone } : {}),
      },
    })
    console.log(`• owner ${ownerEmail} already exists — permissions refreshed (${ALL_PERMISSIONS.length} grants)`)
  } else {
    await db.user.create({
      data: {
        vendorId: vendor.id,
        email: ownerEmail,
        name: ownerName,
        phone: ownerPhone,
        passwordHash: hashPassword(ownerPassword),
        role: "VENDOR_OWNER",
        permissions: JSON.stringify(ALL_PERMISSIONS),
        status: "ACTIVE",
        // C-02 — seeded credentials travel in a public artifact: force rotation
        // on first login (passwordChangedAt=epoch + policy expiryDays=90 below).
        passwordChangedAt: new Date(0),
      },
    })
    console.log(`✓ owner account ${ownerEmail} created (VENDOR_OWNER, ${ALL_PERMISSIONS.length} permissions = ${MODULES.length} modules × ${ACTIONS.length} actions)`)
  }

  // ---- 2b. C-02 — password rotation policy ---------------------------------
  // 90-day expiry + passwordChangedAt=epoch above forces the owner through the
  // mandatory change-password flow on FIRST login (auth.ts HRM-007). reset()
  // also purged the Session table, so no live sessions ship with the database.
  await db.hrSetting.upsert({
    where: { vendorId_group_key: { vendorId: vendor.id, group: "passwordPolicy", key: "expiryDays" } },
    create: { vendorId: vendor.id, group: "passwordPolicy", key: "expiryDays", value: "90" },
    update: { value: "90" },
  })
  console.log("✓ password policy (90-day expiry — owner rotates password on first login)")

  // ---- 3. approval workflows (all 14 access flows) ---------------------------
  const vendors = keepData ? await db.vendor.findMany() : [vendor]
  let createdWf = 0
  for (const v of vendors) {
    for (const processType of PROCESS_TYPES) {
      const existing = await db.approvalWorkflow.findFirst({ where: { vendorId: v.id, processType } })
      if (existing) continue
      const wf = await db.approvalWorkflow.create({
        data: {
          vendorId: v.id, processType,
          name: `${processType.replace(/_/g, " ")} Approval`.replace(/\b\w/g, (c) => c.toUpperCase()),
          active: true,
          description: "Seeded default: single Owner Approval step — customize in Settings → Approval Workflows",
        },
      })
      await db.approvalStep.create({
        data: {
          vendorId: v.id, // DB-02 (R5)
          workflowId: wf.id, sequence: 1, name: "Owner Approval",
          approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL",
        },
      })
      createdWf++
    }
  }
  const wfTotal = await db.approvalWorkflow.count({ where: { vendorId: vendor.id } })
  console.log(`✓ approval workflows: ${createdWf} created, ${wfTotal}/14 configured for ${vendor.code} (single Owner Approval step each)`)

  // ---- 4. statutory configuration (NOT demo data) ----------------------------
  // 4a. AIT FY 2025-26 (Finance Ordinance 2025) — required by Payroll AIT
  const fyId = await ensureAitConfig(vendor.id)
  const [cats, slabs] = await Promise.all([
    db.aitTaxpayerCategory.count({ where: { fiscalYearId: fyId } }),
    db.aitTaxSlab.count({ where: { fiscalYearId: fyId } }),
  ])
  console.log(`✓ AIT statutory config bootstrapped (FY 2025-26, ${cats} taxpayer categories, ${slabs} slabs)`)

  // 4b. BD statutory leave types
  let createdLt = 0
  for (const v of vendors) {
    for (const [code, name, paid, days, cf, encash] of LEAVE_TYPE_DEFS) {
      const existing = await db.leaveType.findFirst({ where: { vendorId: v.id, code } })
      if (existing) continue
      await db.leaveType.create({
        data: {
          vendorId: v.id, code, name, paid, defaultDays: days,
          carryForward: cf, maxCarryForward: cf ? 5 : 0,
          encashmentAllowed: encash,
          waitingPeriodDays: code === "CASUAL" ? 0 : 30,
          probationEligible: ["CASUAL", "SICK", "EMERGENCY"].includes(code),
          // LVE-113 (R7) — medical certificate + consecutive-run cap
          requiresAttachment: code === "SICK",
          maxConsecutiveDays: code === "CASUAL" ? 3 : 0,
        },
      })
      createdLt++
    }
    // LVE-113 (R7) — festival/national holiday template, FRESH vendors only
    const hasHolidays = await db.holiday.count({ where: { vendorId: v.id } })
    if (!hasHolidays) {
      const year = new Date().getFullYear()
      let seededHolidays = 0
      for (const [mmdd, name] of BD_HOLIDAY_TEMPLATE) {
        await db.holiday.create({ data: { vendorId: v.id, name, date: `${year}-${mmdd}`, type: "PUBLIC" } })
        seededHolidays++
      }
      if (seededHolidays) console.log(`✓ BD holiday template (${seededHolidays} fixed-date national days, ${year}) for ${v.code}`)
    }
  }
  const ltTotal = await db.leaveType.count({ where: { vendorId: vendor.id } })
  console.log(`✓ statutory leave types: ${createdLt} created, ${ltTotal} total for ${vendor.code}`)

  // ---- summary --------------------------------------------------------------
  const counts = {
    users: await db.user.count({ where: { vendorId: vendor.id } }),
    employees: await db.employee.count({ where: { vendorId: vendor.id } }),
    attendance: await db.attendance.count({ where: { vendorId: vendor.id } }),
    payrollRuns: await db.payrollRun.count({ where: { vendorId: vendor.id } }),
    loans: await db.loan.count({ where: { vendorId: vendor.id } }),
    devices: await db.attendanceDevice.count({ where: { vendorId: vendor.id } }),
    cameras: await db.camera.count({ where: { vendorId: vendor.id } }),
  }
  console.log("")
  console.log("════════════════════════════════════════════════════════════════")
  console.log(`  Clean tenant seeded — "${vendor.name}"`)
  console.log("════════════════════════════════════════════════════════════════")
  console.log(`  Owner login : ${ownerEmail}`)
  console.log(`  Password    : ${"*".repeat(ownerPassword.length)} (from HRM_SEED_OWNER_PASSWORD / HRM_SEED_PASSWORD)`)
  console.log(`  Permissions : ${ALL_PERMISSIONS.length} (every module × action — includes camera.*)`)
  console.log(`  Workflows   : ${wfTotal}/14 · Leave types: ${ltTotal} · AIT: FY 2025-26 active`)
  console.log(`  Users: ${counts.users} · Employees: ${counts.employees} · Attendance: ${counts.attendance} · Payroll runs: ${counts.payrollRuns} · Loans: ${counts.loans} · Devices: ${counts.devices} · Cameras: ${counts.cameras}`)
  console.log("  (all zero above = no dummy data — build your real organization in the UI)")

  // ---- 5. SaaS platform layer (plans + owner console account; NO demo data) ----
  try {
    const { seedSaaSLayer } = await import("./saas/seed-saas")
    const lines = await seedSaaSLayer({ demo: false })
    console.log("\n── SaaS layer (plans + owner console; no demo data) ──")
    lines.forEach((l) => console.log("  " + l))
    console.log("  Owner console: /owner (sign in with HRM_SAAS_OWNER_EMAIL / HRM_SAAS_OWNER_PASSWORD;")
    console.log("  if no password was configured, use the ONE-TIME password the SaaS layer printed above)")
  } catch (e: any) {
    console.error("  [seed:owner] SaaS layer bootstrap failed:", e?.message || e)
  }
  console.log("════════════════════════════════════════════════════════════════")
}

main()
  .catch((e) => { console.error("seed-owner failed:", e); process.exit(1) })
  .finally(() => db.$disconnect())

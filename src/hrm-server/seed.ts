// ============ Finix HR — TEST seed (HUGE dummy data) ============
// Creates TWO vendors (Bengal Textworks + Rongin Traders) to prove tenant
// isolation, full organization structure, a curated demo cast of 24 employees
// with users for every role, shifts, attendance history, leave, payroll
// history (PAID run with payslips + accounting journals), loans, KPIs,
// letters, announcements — PLUS a configurable BULK TEST CORPUS:
//
//   SEED_TEST_BULK_EMPLOYEES        (default 800)  extra dummy employees
//   SEED_TEST_ATTENDANCE_DAYS       (default 180)  days of attendance history
//   SEED_TEST_PAYROLL_HISTORY_MONTHS (default 3)   extra PAID historical runs
//   SEED_TEST_BULK_USERS            (default 25)   ESS login accounts
//   SEED_TEST_RANDOM_SEED           (default 42)   deterministic corpus
//   SEED_TEST_TIMEOUT_MS            (default 900000) hard timeout when bulk>0
//
// All knobs live in .env / .env.test (see .env.example). Bulk data is batched
// (createMany) and deterministic (seeded PRNG) so test corpora are reproducible.
// Set SEED_TEST_BULK_EMPLOYEES=0 for the classic curated-only demo corpus.
//
// For a CLEAN PRODUCTION tenant use the OTHER seed instead:
//   bun run seed:prod   (= src/hrm-server/seed-owner.ts, NO dummy data)
//
// Run: bun run seed   (or: bun run seed:test — loads .env.test)
import { db } from "@/lib/db"
import { maybeEncryptVc } from "./cameras/repository"
import { encryptPiiText, piiEncryptionAvailable } from "./pii-field"

/** F28 (P6) — demo PII (bank/MFS/NID numbers) encrypts at seed time when a
 *  deployment key is configured; keyless dev seeds keep legacy plaintext
 *  rows (readable until scripts/encrypt-secrets-at-rest.ts rotates them). */
function seedPii(value: string): string {
  return piiEncryptionAvailable() ? encryptPiiText(value) : value
}

// C-5 / HIGH-1 (this audit) — production deployments MUST set HRM_SEED_PASSWORD
// to a value that is NOT the well-known "Pass@123" demo default. The seed script
// refuses to run in production with the default value (instrumentation.ts also
// refuses boot; this is the second line of defense at seed time).
const SEED_PASSWORD_RAW = process.env.HRM_SEED_PASSWORD || "Pass@123"
const PLACEHOLDER_PATTERNS = /^(Pass@123|CHANGE_ME|GENERATE_WITH_|<)/i
if (process.env.NODE_ENV === "production" && (SEED_PASSWORD_RAW === "Pass@123" || PLACEHOLDER_PATTERNS.test(SEED_PASSWORD_RAW))) {
  console.error("[seed] HRM_SEED_PASSWORD is the well-known default or a placeholder — refusing to seed in production.")
  console.error("       Override with a strong password before running `bun run seed:owner`.")
  process.exit(1)
}
const SEED_PASSWORD = SEED_PASSWORD_RAW
import { hashPassword } from "./auth"
import { registerAllHooks } from "./routes/hooks"
import { calculateRun, payRun } from "./payroll"
import { monthName, addDays, dailyRate } from "./utils"
import { fingerprint } from "./zkteco/adapter"
import { mapAndProcessEvent } from "./zkteco/processor"
import { computeAttendance } from "./routes/attendance"
import { resetDatabase } from "./seed-reset"
import type { Ctx } from "./types"

// ---- TEST-seed volume knobs (see .env / .env.test / .env.example) ----------
const envInt = (name: string, dflt: number, min = 0) => {
  const n = parseInt(process.env[name] || "", 10)
  return Number.isFinite(n) && n >= 0 ? Math.max(min, n) : dflt
}
const BULK_EMPLOYEES = envInt("SEED_TEST_BULK_EMPLOYEES", 800)
const ATTENDANCE_DAYS = envInt("SEED_TEST_ATTENDANCE_DAYS", 180, 62) // ≥ 2 months (curated corpus covered prev+current month)
const PAYROLL_HISTORY_MONTHS = envInt("SEED_TEST_PAYROLL_HISTORY_MONTHS", 3)
const BULK_USERS = envInt("SEED_TEST_BULK_USERS", 25)
const RAND_SEED = parseInt(process.env.SEED_TEST_RANDOM_SEED || "42", 10) || 42

// Deterministic PRNG (mulberry32) — reproducible bulk corpora for tests.
// The curated cast above keeps its original Math.random() behaviour.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(RAND_SEED)
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]
const ri = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1))

// C-5 — production deployments MUST set HRM_SEED_PASSWORD (see .env.example);
// the fallback keeps local development's documented demo value only.

const NOW = new Date()
const YEAR = NOW.getFullYear()
const MONTH = NOW.getMonth() + 1
const TODAY = `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`
const PREV_MONTH = MONTH === 1 ? 12 : MONTH - 1
const PREV_YEAR = MONTH === 1 ? YEAR - 1 : YEAR
const iso = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => { const d = new Date(NOW); d.setDate(d.getDate() - n); return iso(d) }
const dstr = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`

async function reset() {
  // Full 92-model wipe (shared with seed-owner.ts) — the historical demo list
  // predated procurement/inventory/AIT/PF and crashed re-runs on unique keys.
  await resetDatabase(db, "test seed — no data kept")
}

async function main() {
  await reset()
  registerAllHooks()

  // Prevent the seed from hanging forever (payroll/attendance sections can
  // cause DB socket timeouts on slow machines). 5-minute hard limit for the
  // curated-only corpus; the huge bulk corpus gets a 15-minute default
  // (SEED_TEST_TIMEOUT_MS) because it inserts 100k+ rows.
  const seedTimeoutMs = BULK_EMPLOYEES > 0
    ? envInt("SEED_TEST_TIMEOUT_MS", 900_000, 60_000)
    : 300_000
  const seedTimeout = setTimeout(() => {
    console.error(`\n⚠ SEED TIMEOUT — force-exiting after ${Math.round(seedTimeoutMs / 60000)} minutes. Camera data was seeded early and should be present.`)
    process.exit(1)
  }, seedTimeoutMs)
  seedTimeout.unref()

  // ============ VENDORS ============
  const finix = await db.vendor.create({ data: { name: "Bengal Textworks Ltd.", code: "FINIX", legalName: "Bengal Textworks Ltd.", address: "House 12, Road 7, Banani, Dhaka 1213", phone: "+880 2 55667788", email: "info@bengaltextworks.example" } })
  const rongin = await db.vendor.create({ data: { name: "Rongin Traders", code: "RONGIN", address: "15/A Kawran Bazar, Dhaka", phone: "+880 2 88990011", email: "hello@rongintraders.com" } })
  console.log("✓ 2 vendors (Bengal Textworks, Rongin Traders)")

  // ============ ORGANIZATION (Finix) ============
  const branches = {} as Record<string, string>
  const branchDefs: [string, string, string, number, number, string][] = [
    ["HO", "Head Office — Banani", "OFFICE", 23.7925, 90.4078, "09:00-18:00"],
    ["ST01", "Textworks — Dhanmondi Plant", "STORE", 23.7461, 90.3762, "10:00-21:00"],
    ["ST02", "Textworks — Uttara Plant", "STORE", 23.8759, 90.3795, "10:00-21:00"],
    ["WH01", "Central Warehouse — Tejgaon", "WAREHOUSE", 23.7608, 90.3662, "08:00-17:00"],
  ]
  for (const [code, name, type, lat, lng, hours] of branchDefs) {
    branches[code] = (await db.branch.create({
      data: { vendorId: finix.id, code, name, type, address: name + ", Dhaka", contact: "+880 17" + Math.floor(10000000 + Math.random() * 89999999), operatingHours: hours, latitude: lat, longitude: lng, geofenceRadius: 200, geofenceActive: true, active: true },
    })).id
  }

  const depts = {} as Record<string, string>
  const deptDefs: [string, string, string, string][] = [
    ["MGMT", "Management", "ব্যবস্থাপনা", "HO"], ["SALES", "Sales", "বিক্রয়", "ST01"],
    ["CS", "Customer Service", "গ্রাহক সেবা", "ST01"], ["ACC", "Accounts", "হিসাব", "HO"],
    ["HR", "Human Resources", "মানব সম্পদ", "HO"], ["MKT", "Marketing", "বাজারজাতকরণ", "HO"],
    ["WH", "Warehouse", "গুদাম", "WH01"], ["INV", "Inventory", "মজুদ", "WH01"],
    ["PRO", "Procurement", "ক্রয়", "HO"], ["OPS", "Operations", "অপারেশন", "HO"],
    ["IT", "IT", "আইটি", "HO"], ["DLV", "Delivery", "ডেলিভারি", "WH01"],
  ]
  for (const [code, name, nameBn, branch] of deptDefs) {
    depts[code] = (await db.department.create({ data: { vendorId: finix.id, code, name, nameBn, branchId: branches[branch], description: name + " department", status: "ACTIVE" } })).id
  }

  const desigs = {} as Record<string, string>
  const desigDefs: [string, string, string, string, number, number][] = [
    ["MD", "Managing Director", "ব্যবস্থাপনা পরিচালক", "MGMT", 150000, 400000],
    ["GM", "General Manager", "জেনারেল ম্যানেজার", "MGMT", 90000, 180000],
    ["HRM", "HR Manager", "মানব সম্পদ ম্যানেজার", "HR", 45000, 90000],
    ["HRO", "HR Officer", "মানব সম্পদ কর্মকর্তা", "HR", 22000, 40000],
    ["AM", "Accounts Manager", "হিসাব ম্যানেজার", "ACC", 50000, 100000],
    ["AO", "Accounts Officer", "হিসাব কর্মকর্তা", "ACC", 25000, 45000],
    ["SM", "Store Manager", "স্টোর ম্যানেজার", "SALES", 40000, 70000],
    ["SS", "Sales Supervisor", "বিক্রয় সুপারভাইজার", "SALES", 22000, 35000],
    ["SE", "Sales Executive", "বিক্রয় কর্মকর্তা", "SALES", 16000, 28000],
    ["CSR", "Customer Service Rep.", "গ্রাহক সেবা প্রতিনিধি", "CS", 15000, 24000],
    ["WM", "Warehouse Manager", "গুদাম ম্যানেজার", "WH", 38000, 65000],
    ["WK", "Warehouse Keeper", "গুদাম রক্ষক", "WH", 16000, 26000],
    ["MT", "Marketing Executive", "মার্কেটিং কর্মকর্তা", "MKT", 20000, 38000],
    ["ITO", "IT Officer", "আইটি কর্মকর্তা", "IT", 30000, 60000],
    ["DRV", "Delivery Rider", "ডেলিভারি রাইডার", "DLV", 14000, 20000],
  ]
  for (const [code, name, nameBn, dept, minS, maxS] of desigDefs) {
    desigs[code] = (await db.designation.create({ data: { vendorId: finix.id, code, name, nameBn, departmentId: depts[dept], grade: code === "MD" ? "A+" : code === "GM" ? "A" : ["HRM", "AM", "SM", "WM"].includes(code) ? "B" : "C", minSalary: minS, maxSalary: maxS, status: "ACTIVE" } })).id
  }
  console.log("✓ organization (4 branches, 12 departments, 15 designations)")

  // ============ CAMERA MANAGER (Phase 6+) — seeded EARLY so data exists even if later sections hang ============
  {
    const CAMERAS_BASE = "cameras"
    const camerasCtx = (v: number) => `${CAMERAS_BASE}::v${v}`

    const finixCams: [string, string, string, string | null, string | null, string, string, boolean][] = [
      ["HIKVISION", "Warehouse Gate 1", "DS-2CD2043G2-2026A001", "HVC-001-XYZ", "WH01", "Gate 1 — Loading Dock", "ONLINE", true],
      ["HIKVISION", "Warehouse Gate 2", "DS-2CD2043G2-2026A002", "HVC-002-ABC", "WH01", "Gate 2 — Receiving", "ONLINE", true],
      ["DAHUA", "HO Reception", "DH-IPC-HFW1234S-S5", "DVC-003-DEF", "HO", "Front Desk", "ONLINE", true],
      ["DAHUA", "HO Parking Lot", "DH-IPC-HDW3411S-S2", "DVC-004-GHI", "HO", "Parking Lot — North", "OFFLINE", true],
      ["EZVIZ", "Dhanmondi Store Front", "C6T-2026E001", null, "ST01", "Store Entrance", "ONLINE", true],
      ["EZVIZ", "Dhanmondi Store Back", "C6T-2026E002", null, "ST01", "Stock Room", "UNKNOWN", true],
      ["IMOU", "Uttara Store Aisle 3", "IPC322-2026I001", null, "ST02", "Aisle 3 — End Cap", "ONLINE", true],
      ["HIKVISION", "WH Perimeter (decommissioned)", "DS-2DE4220IW-DE-2025X099", "HVC-005-JKL", "WH01", "Perimeter — South Wall", "OFFLINE", false],
    ]
    for (const [brand, name, serial, vc, branchKey, location, status, enabled] of finixCams) {
      await db.camera.create({ data: { vendorId: finix.id, brand, name, serialNumber: serial, channel: 1, verificationCode: maybeEncryptVc(vc), /* L-24 — encrypted at rest */ branchId: branchKey ? branches[branchKey] : null, location, installDate: dstr(YEAR, MONTH, 1), status, lastStatusCheckAt: new Date(), lastSeenAt: status === "ONLINE" ? new Date() : null, lastError: status === "OFFLINE" ? `Device unreachable (last polled ${TODAY})` : null, enabled } })
    }
    console.log(`✓ ${finixCams.length} cameras for the demo tenant (7 active + 1 soft-deleted, 4 brands)`)

    const ronginCams: [string, string, string, string | null, string, string, boolean][] = [
      ["HIKVISION", "Office Entrance", "DS-2CD2185FWD-I-2026R001", "HVC-R01-MNO", "Main Entrance", "ONLINE", true],
      ["EZVIZ", "Warehouse Back Door", "C3X-2026R001", null, "Back Door — Loading", "UNKNOWN", true],
    ]
    for (const [brand, name, serial, vc, location, status, enabled] of ronginCams) {
      await db.camera.create({ data: { vendorId: rongin.id, brand, name, serialNumber: serial, channel: 1, verificationCode: maybeEncryptVc(vc), /* L-24 — encrypted at rest */ branchId: null, location, installDate: dstr(YEAR, MONTH, 15), status, lastStatusCheckAt: new Date(), lastSeenAt: status === "ONLINE" ? new Date() : null, enabled } })
    }
    console.log(`✓ ${ronginCams.length} cameras for Rongin Traders (2 brands)`)

    if (process.env.HRM_MFA_KEY) {
      const { encryptField } = await import("./crypto-field")
      const ctx = camerasCtx(1)
      await db.cameraCredential.create({ data: { vendorId: finix.id, brand: "EZVIZ", encryptedPayload: encryptField(JSON.stringify({ appKey: "demo-ezviz-appkey", appSecret: "demo-ezviz-appsecret" }), ctx), encryptionKeyVersion: 1 } })
      await db.cameraCredential.create({ data: { vendorId: finix.id, brand: "IMOU", encryptedPayload: encryptField(JSON.stringify({ appId: "demo-imou-appid", appSecret: "demo-imou-appsecret" }), ctx), encryptionKeyVersion: 1 } })
      console.log("✓ EZVIZ + IMOU credentials seeded for the demo tenant (encrypted with cameras::v1 context)")
    } else {
      console.log("⚠  EZVIZ/IMOU credentials NOT seeded — HRM_MFA_KEY not set (crypto-field requires it)")
    }
  }

  // ============ SHIFTS ============
  const shifts = {} as Record<string, string>
  const shiftDefs: [string, string, string, string][] = [
    ["GEN", "General (9-5)", "09:00", "18:00"],
    ["MOR", "Morning Store Shift", "08:00", "16:00"],
    ["EVE", "Evening Store Shift", "14:00", "22:00"],
    ["NGT", "Night Warehouse Shift", "22:00", "06:00"],
  ]
  for (const [code, name, st, et] of shiftDefs) {
    shifts[code] = (await db.shift.create({ data: { vendorId: finix.id, name, type: "FIXED", startTime: st, endTime: et, graceMinutes: 10, breakMinutes: 60, minWorkingHours: 8, otThresholdMinutes: 30, otMultiplier: 1.5, weeklyOff: "FRIDAY", active: true } })).id
  }
  console.log("✓ shifts (4)")

  // ============ HOLIDAYS 2026 ============
  const holidays2026: [string, string][] = [
    ["2026-02-15", "Shab-e-Barat"], ["2026-02-21", "Language Martyrs Day"], ["2026-03-17", "Sheikh Russel Day"],
    ["2026-03-26", "Independence Day"], ["2026-04-14", "Bengali New Year (Pohela Boishakh)"],
    ["2026-05-01", "May Day"], ["2026-08-05", "July Uprising Day"], ["2026-08-15", "Assumption of Mary"],
    ["2026-10-02", "Durga Puja Bijoya Dashami"], ["2026-10-18", "Eid-e-Miladunnabi"],
    ["2026-12-16", "Victory Day"], ["2026-12-25", "Christmas Day"],
  ]
  for (const [date, name] of holidays2026) {
    await db.holiday.create({ data: { vendorId: finix.id, name, date, type: "PUBLIC" } })
  }
  await db.holiday.create({ data: { vendorId: finix.id, name: "Company Foundation Day", date: `${YEAR}-06-01`, type: "COMPANY" } })
  console.log("✓ holidays 2026")

  // ============ APPROVAL WORKFLOWS (all 10 process types) ============
  const wfDefs: [string, string, any[]][] = [
    ["LEAVE", "Leave Approval", [
      { name: "Supervisor / Manager", approverRole: "BRANCH_MANAGER", branchScope: true },
      { name: "HR Review", approverRole: "HR_MANAGER" },
    ]],
    ["LOAN", "Loan Approval", [
      { name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true, amountThreshold: 50000 },
      { name: "HR Review", approverRole: "HR_MANAGER" },
      { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" },
    ]],
    ["ADVANCE", "Advance Approval", [
      { name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true, amountThreshold: 20000 },
      { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" },
    ]],
    ["EXPENSE", "Expense Approval", [
      { name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true },
      { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" },
    ]],
    ["PAYROLL", "Payroll Approval", [
      { name: "HR Review", approverRole: "HR_MANAGER" },
      { name: "Manager Approval", approverRole: "HR_ADMIN" },
      { name: "Finance / Accounting Approval", approverRole: "PAYROLL_OFFICER" },
    ]],
    ["LETTER", "HR Letter Approval", [
      { name: "HR Review", approverRole: "HR_MANAGER" },
      { name: "Management Approval", approverRole: "HR_ADMIN" },
    ]],
    ["RESIGNATION", "Resignation Approval", [
      { name: "Reporting Manager", approverRole: "BRANCH_MANAGER", branchScope: true },
      { name: "Department Head", approverRole: "DEPT_MANAGER" },
      { name: "HR Review", approverRole: "HR_MANAGER" },
      { name: "Management", approverRole: "HR_ADMIN" },
    ]],
    ["PROMOTION", "Promotion Approval", [
      { name: "HR Review", approverRole: "HR_MANAGER" },
      { name: "Management Approval", approverRole: "HR_ADMIN" },
    ]],
    ["TRANSFER", "Transfer Approval", [
      { name: "HR Review", approverRole: "HR_MANAGER" },
      { name: "Management Approval", approverRole: "HR_ADMIN" },
    ]],
    ["SALARY_REVISION", "Salary Revision Approval", [
      { name: "HR Review", approverRole: "HR_MANAGER" },
      { name: "Management Approval", approverRole: "HR_ADMIN" },
    ]],
    ["OVERTIME", "Overtime Approval", [
      { name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true },
      { name: "HR Review", approverRole: "HR_MANAGER" },
    ]],
    ["ENCASHMENT", "Leave Encashment Approval", [
      { name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true },
      { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" },
    ]],
  ]
  for (const [processType, name, steps] of wfDefs) {
    const wf = await db.approvalWorkflow.create({ data: { vendorId: finix.id, processType, name, active: true } })
    let seq = 1
    for (const s of steps) {
      await db.approvalStep.create({
        data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: seq++, name: s.name, approverRole: s.approverRole || null, departmentScope: !!s.departmentScope, branchScope: !!s.branchScope, amountThreshold: s.amountThreshold ?? null, required: true, rejectBehavior: "REJECT_ALL" },
      })
    }
  }
  // minimal workflows for vendor 2
  for (const pt of ["LEAVE", "LOAN", "EXPENSE", "PAYROLL", "LETTER", "RESIGNATION", "ADVANCE", "PROMOTION", "TRANSFER", "SALARY_REVISION", "OVERTIME", "ENCASHMENT"]) {
    const wf = await db.approvalWorkflow.create({ data: { vendorId: rongin.id, processType: pt, name: pt + " workflow", active: true } })
    await db.approvalStep.create({ data: { vendorId: rongin.id, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true } })
  }
  console.log("✓ approval workflows (12 process types × 2 vendors)")

  // ============ LEAVE TYPES ============
  // LVE-113 (R7) — the seeded policy now follows the BD labour norms the
  // audit checked: encashment applies to ANNUAL (earned) leave ONLY, sick
  // leave requires a medical certificate, casual leave runs in short
  // stretches (3-day consecutive cap), and the EARNED duplicate (18 days
  // alongside ANNUAL 20) is gone — one annual/earned quota, one type.
  const leaveTypes = {} as Record<string, string>
  const ltDefs: [string, string, boolean, number, boolean, boolean][] = [
    ["CASUAL", "Casual Leave", true, 10, false, false],
    ["SICK", "Sick Leave", true, 14, false, false],
    ["ANNUAL", "Annual Leave", true, 20, true, true],
    ["EMERGENCY", "Emergency Leave", true, 7, false, false],
    ["MATERNITY", "Maternity Leave", true, 112, false, false],
    ["PATERNITY", "Paternity Leave", true, 7, false, false],
    ["UNPAID", "Unpaid Leave", false, 15, false, false],
  ]
  for (const [code, name, paid, days, cf, encash] of ltDefs) {
    leaveTypes[code] = (await db.leaveType.create({
      // LVE-107 — the statutory types are gender-gated (maternity → FEMALE,
      // paternity → MALE); the apply path enforces the column.
      // LVE-113 (R7) — SICK requires a medical certificate attachment and
      // CASUAL carries the 3-day consecutive-run cap (both enforced at apply).
      data: { vendorId: finix.id, code, name, paid, defaultDays: days, carryForward: cf, maxCarryForward: cf ? 5 : 0, encashmentAllowed: encash, waitingPeriodDays: code === "CASUAL" ? 0 : 30, probationEligible: ["CASUAL", "SICK", "EMERGENCY"].includes(code), genderRestriction: code === "MATERNITY" ? "FEMALE" : code === "PATERNITY" ? "MALE" : null, requiresAttachment: code === "SICK", maxConsecutiveDays: code === "CASUAL" ? 3 : 0 },
    })).id
  }
  // LVE-113 — the demo encashment fixtures ride on ANNUAL (the one encashable
  // statutory type) instead of the removed EARNED duplicate.
  leaveTypes["EARNED"] = leaveTypes["ANNUAL"]
  console.log("✓ leave types (7 with BD-compliant policies)")

  // ============ TAX RULE SETS (BD-style slabs) ============
  const taxSet = await db.taxRuleSet.create({
    data: { vendorId: finix.id, name: "BD Individual Slab (Illustrative)", financialYear: "2025-26", mode: "SLAB", taxFreeThreshold: 350000, rebatePercent: 0, effectiveFrom: "2025-07-01", active: true, source: "Vendor-configured illustration of Bangladesh individual tax slabs; must be reviewed by finance/tax personnel for statutory processing", notes: "Progressive bands above ৳3,50,000 tax-free threshold" },
  })
  const slabs = [
    { minIncome: 0, maxIncome: 100000, rate: 5 }, { minIncome: 100000, maxIncome: 300000, rate: 10 },
    { minIncome: 300000, maxIncome: 500000, rate: 15 }, { minIncome: 500000, maxIncome: 800000, rate: 20 },
    { minIncome: 800000, maxIncome: 1200000, rate: 25 }, { minIncome: 1200000, maxIncome: null, rate: 30 },
  ]
  for (const s of slabs) {
    await db.taxSlab.create({ data: { vendorId: taxSet.vendorId, ruleSetId: taxSet.id, ...s } })
  }
  const _flatSet = await db.taxRuleSet.create({
    data: { vendorId: finix.id, name: "Flat 5% (Simplified)", financialYear: "2025-26", mode: "PERCENT", percent: 5, taxableBase: "GROSS", taxFreeThreshold: 0, active: false },
  })
  console.log("✓ tax rule sets (slab + flat)")

  // ============ LETTER TEMPLATES (19 types) ============
  const templates: [string, string, string, string][] = [
    ["APPOINTMENT", "Appointment Letter", "Appointment — {{employee_name}}",
`Dear {{employee_name}},

We are pleased to offer you the position of {{designation}} in the {{department}} department at {{branch}} of {{company_name}}, effective from {{joining_date}}.

Your employment terms:
- Employment Type: {{employment_type}}
- Probation Period: {{probation_months}} months
- Monthly Gross Salary: ৳{{gross_salary}}
- Reporting Manager: {{manager_name}}
- Working Hours: As per company policy

Please sign and return a copy of this letter as acceptance of the offer.

Welcome to the {{company_name}} family!`],
    ["CONFIRMATION", "Employment Confirmation", "Confirmation of Employment — {{employee_name}}",
`Dear {{employee_name}},

This is to formally confirm your employment as {{designation}} in the {{department}} department at {{company_name}}, following successful completion of your probation period.

Your confirmation is effective from {{effective_date}}. We appreciate your contribution during the probation period and look forward to your continued growth with us.`],
    ["PROBATION_EXT", "Probation Extension", "Probation Extension — {{employee_name}}",
`Dear {{employee_name}},

Your probation period as {{designation}} has been extended by additional time as per management decision, effective {{effective_date}}. A structured improvement plan has been shared with you separately.

We encourage you to use this period to demonstrate the required competencies.`],
    ["SALARY_CERT", "Salary Certificate", "Salary Certificate — {{employee_name}}",
`TO WHOM IT MAY CONCERN

This is to certify that {{employee_name}} (Employee ID: {{employee_id}}) has been employed at {{company_name}} as {{designation}} in the {{department}} department since {{joining_date}}.

Current monthly gross remuneration: ৳{{gross_salary}} (Basic: ৳{{basic_salary}}).

This certificate is issued upon employee request for official purposes.`],
    ["EMPLOYMENT_CERT", "Employment Certificate", "Employment Certificate — {{employee_name}}",
`TO WHOM IT MAY CONCERN

This is to certify that {{employee_name}} (Employee ID: {{employee_id}}) is a {{employment_type}} employee of {{company_name}}, serving as {{designation}} in the {{department}} department at {{branch}} since {{joining_date}}.

This certificate is issued on {{date}} for the employee's personal records.`],
    ["EXPERIENCE", "Experience Certificate", "Experience Certificate — {{employee_name}}",
`TO WHOM IT MAY CONCERN

This is to certify that {{employee_name}} served at {{company_name}} as {{designation}} in the {{department}} department from {{joining_date}} to {{effective_date}}.

During the tenure, we found {{employee_name}} sincere, dedicated and professional. We wish them success in future endeavors.`],
    ["INCREMENT", "Increment Letter", "Salary Increment — {{employee_name}}",
`Dear {{employee_name}},

We are pleased to inform you that, in recognition of your performance and contribution, your monthly gross salary has been revised effective {{effective_date}}.

Revised Monthly Gross Salary: ৳{{gross_salary}}

Congratulations and keep up the great work!`],
    ["PROMOTION", "Promotion Letter", "Promotion — {{employee_name}}",
`Dear {{employee_name}},

It is our pleasure to promote you to the position of {{designation}} in the {{department}} department, effective {{effective_date}}, in recognition of your outstanding performance and leadership.

We are confident you will continue to excel in your elevated responsibilities.`],
    ["TRANSFER", "Transfer Letter", "Transfer Order — {{employee_name}}",
`Dear {{employee_name}},

This is to inform you that you are being transferred to {{branch}} with effect from {{effective_date}}, in the interest of the company.

You are requested to hand over your current responsibilities and join the new location on the effective date.`],
    ["WARNING", "Warning Letter", "Warning — {{employee_name}}",
`Dear {{employee_name}},

It has been observed that your performance/conduct has not met the expected standard despite prior verbal counseling. This letter serves as a formal warning.

You are advised to show immediate and sustained improvement. Any recurrence may lead to further disciplinary action as per company policy.`],
    ["APPRECIATION", "Appreciation Letter", "Appreciation — {{employee_name}}",
`Dear {{employee_name}},

We would like to express our sincere appreciation for your exceptional contribution as {{designation}} in the {{department}} department.

Your dedication reflects the values of {{company_name}}. Thank you and congratulations!`],
    ["SHOW_CAUSE", "Show Cause Letter", "Show Cause Notice — {{employee_name}}",
`Dear {{employee_name}},

You are hereby directed to show cause within 7 (seven) working days as to why disciplinary action should not be taken against you for the reported incident.

Failure to respond within the stipulated time will be treated as admission of the allegation.`],
    ["SUSPENSION", "Suspension Letter", "Suspension — {{employee_name}}",
`Dear {{employee_name}},

You are hereby placed under suspension effective {{effective_date}} pending investigation, as per the applicable service rules of {{company_name}}.

You shall remain away from the workplace during the suspension period until further notice.`],
    ["TERMINATION", "Termination Letter", "Termination of Employment — {{employee_name}}",
`Dear {{employee_name}},

This is to inform you that your employment with {{company_name}} as {{designation}} is terminated effective {{effective_date}}, in accordance with the terms of your appointment and applicable law.

Notice requirements and settlement details are as per the attached schedule. Company assets must be returned before final clearance.`],
    ["RESIGN_ACCEPT", "Resignation Acceptance", "Acceptance of Resignation — {{employee_name}}",
`Dear {{employee_name}},

We acknowledge receipt of your resignation dated {{effective_date}} and hereby accept it. As per policy, your notice period terms apply and your last working day will be confirmed by HR.

We thank you for your service to {{company_name}} and wish you the very best.`],
    ["RELEASE", "Release Letter", "Release Letter — {{employee_name}}",
`TO WHOM IT MAY CONCERN

This is to certify that {{employee_name}} (Employee ID: {{employee_id}}) has been released from the services of {{company_name}} as {{designation}} on {{effective_date}} after satisfactory clearance of all dues and responsibilities.`],
    ["RELIEVING", "Relieving Letter", "Relieving Letter — {{employee_name}}",
`Dear {{employee_name}},

With reference to your resignation, you are hereby relieved from the position of {{designation}} in the {{department}} department of {{company_name}}, effective {{effective_date}}.

We wish you success in your future endeavors.`],
    ["NOC", "No Objection Certificate", "NOC — {{employee_name}}",
`TO WHOM IT MAY CONCERN

This certifies that {{company_name}} has no objection to {{employee_name}} (Employee ID: {{employee_id}}), {{designation}} of the {{department}} department, pursuing the purpose stated in their application dated {{date}}.

This NOC is issued on {{date}} at the employee's request.`],
    ["CUSTOM", "Custom HR Letter", "Letter — {{employee_name}}", `Dear {{employee_name}},\n\n[Custom content configured by HR.]\n\n{{company_name}}`],
  ]
  for (const [type, name, subject, body] of templates) {
    await db.letterTemplate.create({
      data: { vendorId: finix.id, type, name, subject, body, signatoryName: "Nazmul Hasan", signatoryDesignation: "Managing Director", requiresApproval: true, active: true },
    })
  }
  console.log("✓ letter templates (19)")

  // ============ EMPLOYEES ============
  interface EmpSeed {
    code: string; name: string; nameBn?: string; desig: string; dept: string; branch: string; shift: string
    joining: string; type?: string; status?: string; dob: string; gender: string; mobile: string
    gross: number; basicPct?: number
  }
  const empSeeds: EmpSeed[] = [
    { code: "EMP-0001", name: "Nazmul Hasan", nameBn: "নাজমুল হাসান", desig: "MD", dept: "MGMT", branch: "HO", shift: "GEN", joining: dstr(2018, 3, 1), dob: dstr(1982, 9, 14), gender: "Male", mobile: "01711001001", gross: 220000 },
    { code: "EMP-0002", name: "Farhana Ahmed", nameBn: "ফারহানা আহমেদ", desig: "GM", dept: "MGMT", branch: "HO", shift: "GEN", joining: dstr(2019, 6, 15), dob: dstr(1986, 4, 22), gender: "Female", mobile: "01711001002", gross: 120000 },
    { code: "EMP-0003", name: "Rashedul Islam", nameBn: "রাশেদুল ইসলাম", desig: "HRM", dept: "HR", branch: "HO", shift: "GEN", joining: dstr(2020, 1, 5), dob: dstr(1990, 12, 8), gender: "Male", mobile: "01711001003", gross: 62000 },
    { code: "EMP-0004", name: "Nusrat Jahan", nameBn: "নুসরাত জাহান", desig: "HRO", dept: "HR", branch: "HO", shift: "GEN", joining: dstr(2023, 2, 1), dob: dstr(1996, 9, 16), gender: "Female", mobile: "01711001004", gross: 32000 },
    { code: "EMP-0005", name: "Kamrul Hasan", nameBn: "কামরুল হাসান", desig: "AM", dept: "ACC", branch: "HO", shift: "GEN", joining: dstr(2021, 8, 10), dob: dstr(1988, 7, 19), gender: "Male", mobile: "01711001005", gross: 68000 },
    { code: "EMP-0006", name: "Shahana Begum", nameBn: "শাহানা বেগম", desig: "AO", dept: "ACC", branch: "HO", shift: "GEN", joining: dstr(2022, 4, 18), dob: dstr(1993, 2, 11), gender: "Female", mobile: "01711001006", gross: 38000 },
    { code: "EMP-0007", name: "Mahbubur Rahman", nameBn: "মাহবুবুর রহমান", desig: "SM", dept: "SALES", branch: "ST01", shift: "MOR", joining: dstr(2020, 11, 2), dob: dstr(1987, 10, 25), gender: "Male", mobile: "01711001007", gross: 55000 },
    { code: "EMP-0008", name: "Tanvir Alam", nameBn: "তানভীর আলম", desig: "SS", dept: "SALES", branch: "ST01", shift: "MOR", joining: dstr(2022, 6, 20), dob: dstr(1994, 5, 30), gender: "Male", mobile: "01711001008", gross: 30000 },
    { code: "EMP-0009", name: "Rahim Miah", nameBn: "রহিম মিয়া", desig: "SE", dept: "SALES", branch: "ST01", shift: "EVE", joining: dstr(2024, 1, 10), dob: dstr(1998, 3, 14), gender: "Male", mobile: "01711001009", gross: 22000 },
    { code: "EMP-0010", name: "Shirin Sultana", nameBn: "শিরিন সুলতানা", desig: "SE", dept: "SALES", branch: "ST02", shift: "MOR", joining: dstr(2023, 9, 5), dob: dstr(1997, 8, 8), gender: "Female", mobile: "01711001010", gross: 24000 },
    { code: "EMP-0011", name: "Jahangir Alam", nameBn: "জাহাঙ্গীর আলম", desig: "CSR", dept: "CS", branch: "ST01", shift: "EVE", joining: dstr(2024, 3, 12), dob: dstr(1999, 1, 20), gender: "Male", mobile: "01711001011", gross: 19000, type: "PROBATIONARY", status: "PROBATION" },
    { code: "EMP-0012", name: "Mitu Chowdhury", nameBn: "মিতু চৌধুরী", desig: "CSR", dept: "CS", branch: "ST02", shift: "MOR", joining: dstr(2023, 7, 25), dob: dstr(1998, 11, 4), gender: "Female", mobile: "01711001012", gross: 20000 },
    { code: "EMP-0013", name: "Abdul Karim", nameBn: "আব্দুল করিম", desig: "WM", dept: "WH", branch: "WH01", shift: "GEN", joining: dstr(2021, 2, 8), dob: dstr(1985, 6, 17), gender: "Male", mobile: "01711001013", gross: 52000 },
    { code: "EMP-0014", name: "Sohel Rana", nameBn: "সোহেল রানা", desig: "WK", dept: "WH", branch: "WH01", shift: "NGT", joining: dstr(2022, 10, 3), dob: dstr(1995, 12, 28), gender: "Male", mobile: "01711001014", gross: 21000 },
    { code: "EMP-0015", name: "Ripon Das", nameBn: "রিপন দাস", desig: "WK", dept: "INV", branch: "WH01", shift: "GEN", joining: dstr(2024, 5, 6), dob: dstr(2000, 2, 9), gender: "Male", mobile: "01711001015", gross: 18000 },
    { code: "EMP-0016", name: "Papia Akter", nameBn: "পাপিয়া আক্তার", desig: "MT", dept: "MKT", branch: "HO", shift: "GEN", joining: dstr(2023, 4, 17), dob: dstr(1996, 10, 12), gender: "Female", mobile: "01711001016", gross: 30000 },
    { code: "EMP-0017", name: "Imran Hossain", nameBn: "ইমরান হোসেন", desig: "ITO", dept: "IT", branch: "HO", shift: "GEN", joining: dstr(2022, 9, 1), dob: dstr(1994, 8, 21), gender: "Male", mobile: "01711001017", gross: 42000 },
    { code: "EMP-0018", name: "Delwar Hossain", nameBn: "দেলোয়ার হোসেন", desig: "DRV", dept: "DLV", branch: "WH01", shift: "MOR", joining: dstr(2024, 2, 14), dob: dstr(1997, 7, 7), gender: "Male", mobile: "01711001018", gross: 17000 },
    { code: "EMP-0019", name: "Sabrina Haque", nameBn: "সাবরিনা হক", desig: "SE", dept: "SALES", branch: "ST02", shift: "EVE", joining: dstr(2025, 1, 6), dob: dstr(2001, 5, 18), gender: "Female", mobile: "01711001019", gross: 20000, type: "PROBATIONARY", status: "PROBATION" },
    { code: "EMP-0020", name: "Mizanur Rahman", nameBn: "মিজানুর রহমান", desig: "SE", dept: "SALES", branch: "ST01", shift: "MOR", joining: dstr(2021, 12, 1), dob: dstr(1993, 9, 3), gender: "Male", mobile: "01711001020", gross: 26000 },
    { code: "EMP-0021", name: "Anisur Rahman", nameBn: "আনিসুর রহমান", desig: "SS", dept: "SALES", branch: "ST02", shift: "EVE", joining: dstr(2023, 11, 20), dob: dstr(1992, 4, 2), gender: "Male", mobile: "01711001021", gross: 32000 },
    { code: "EMP-0022", name: "Rehana Parvin", nameBn: "রেহানা পারভীন", desig: "AO", dept: "ACC", branch: "HO", shift: "GEN", joining: dstr(2024, 8, 5), dob: dstr(1995, 3, 26), gender: "Female", mobile: "01711001022", gross: 34000 },
    { code: "EMP-0023", name: "Habibur Rahman", nameBn: "হাবিবুর রহমান", desig: "WK", dept: "PRO", branch: "HO", shift: "GEN", joining: dstr(2025, 6, 2), dob: dstr(1999, 9, 9), gender: "Male", mobile: "01711001023", gross: 19000 },
    { code: "EMP-0024", name: "Tasnim Rahman", nameBn: "তাসনিম রহমান", desig: "CSR", dept: "CS", branch: "ST02", shift: "EVE", joining: dstr(2025, 8, 18), dob: dstr(2002, 6, 14), gender: "Female", mobile: "01711001024", gross: 18000, type: "PROBATIONARY", status: "PROBATION" },
  ]

  const empIds = {} as Record<string, string>
  const banks = ["BRAC Bank", "Dutch-Bangla Bank", "City Bank", "Eastern Bank", "Islami Bank", "Prime Bank"]
  const divisions = ["Dhaka", "Chattogram", "Sylhet", "Khulna", "Rajshahi"]
  // 2026-10-14 — deterministic e-TINs for the curated cast (Employee.taxTin,
  // user request): 12-digit BD e-TIN shape, one per employee.
  let tinSeq = 0
  for (const s of empSeeds) {
    const emp = await db.employee.create({
      data: {
        vendorId: finix.id, code: s.code, fullName: s.name, nameBn: s.nameBn, preferredName: s.name.split(" ")[0],
        fatherName: "Md. " + s.name.split(" ").slice(-1)[0] + " Sr.", motherName: "Mrs. " + s.name.split(" ")[0], spouseName: s.gender === "Female" ? "Mr. Khan" : null,
        dob: s.dob, placeOfBirth: divisions[Math.floor(Math.random() * divisions.length)], gender: s.gender,
        bloodGroup: ["A+", "B+", "O+", "AB+", "A-", "B-"][Math.floor(Math.random() * 6)],
        maritalStatus: s.dob < "1993" ? "Married" : "Single", nationality: "Bangladeshi", religion: "Islam",
        mobile: s.mobile, altMobile: "018" + s.mobile.slice(3), personalEmail: s.name.toLowerCase().replace(/ /g, ".") + "@gmail.com",
        officialEmail: s.name.toLowerCase().replace(/ /g, ".") + "@bengaltextworks.example",
        emergencyName: "Family Contact", emergencyRelation: "Relative", emergencyMobile: "019" + s.mobile.slice(3),
        presentAddress: "House " + (Math.floor(Math.random() * 90) + 1) + ", Road " + (Math.floor(Math.random() * 20) + 1) + ", Dhanmondi, Dhaka",
        permanentAddress: "Village: Charpara, P.O: Sadar, Dist: " + divisions[Math.floor(Math.random() * divisions.length)],
        division: "Dhaka", district: divisions[Math.floor(Math.random() * divisions.length)], city: "Dhaka", postCode: "120" + String(Math.floor(Math.random() * 90) + 10),
        presentDivision: "Dhaka", presentDistrict: "Dhaka", presentCity: "Dhaka", presentPostCode: "1209",
        addressSame: Math.random() > 0.7,
        branchId: branches[s.branch], departmentId: depts[s.dept], designationId: desigs[s.desig],
        reportingManagerId: null, hrManagerId: null, supervisorId: null,
        workLocation: s.branch, joiningDate: s.joining,
        probationMonths: s.type === "PROBATIONARY" ? 6 : 3,
        employmentType: s.type || "PERMANENT", status: s.status || "ACTIVE",
        category: "Staff", grade: desigs[s.desig] ? undefined : undefined,
        shiftId: shifts[s.shift], weeklyOff: "FRIDAY",
        contractStart: s.type === "CONTRACTUAL" ? s.joining : null, contractEnd: null,
        // 2026-10-14 — e-TIN (deterministic 12-digit demo numbers)
        taxTin: String(100530000000 + ++tinSeq * 271),
      },
    })
    empIds[s.code] = emp.id
    // designation grade from desig record
    const desigRec = await db.designation.findUnique({ where: { id: desigs[s.desig] } })
    await db.employee.update({ where: { id: emp.id }, data: { grade: desigRec?.grade || "C" } })
    await db.employeeHistory.create({
      data: { vendorId: finix.id, employeeId: emp.id, eventType: "JOINED", title: "Joined the organization", description: `${s.name} joined as ${desigRec?.name}`, effectiveDate: s.joining },
    })
    // salary structure
    const gross = s.gross
    await db.salaryStructure.create({
      data: {
        vendorId: finix.id, employeeId: emp.id, effectiveFrom: s.joining,
        basic: Math.round(gross * 0.5), houseRent: Math.round(gross * 0.2), medical: Math.round(gross * 0.08),
        conveyance: Math.round(gross * 0.06), food: Math.round(gross * 0.05), mobileAllow: Math.round(gross * 0.04),
        internetAllow: Math.round(gross * 0.03), attendanceAllow: Math.round(gross * 0.02), otherAllowance: Math.round(gross * 0.02),
        gross, status: "ACTIVE",
      },
    })
    // family
    await db.familyMember.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, name: "Spouse of " + s.name, relationship: "Spouse", gender: s.gender === "Male" ? "Female" : "Male", dependent: true } })
    await db.familyMember.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, name: "Child of " + s.name, relationship: "Child", dob: dstr(2020, 3, 5), gender: "Male", dependent: true } })
    // education
    await db.education.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, degree: "BBA", examination: "Bachelor", institution: "University of Dhaka", board: "DU", major: "Business Administration", passingYear: String(2010 + Math.floor(Math.random() * 10)), result: "3.50" } })
    await db.education.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, degree: "MSS", examination: "Masters", institution: "Jahangirnagar University", board: "JU", major: "Economics", passingYear: String(2012 + Math.floor(Math.random() * 8)), result: "3.20" } })
    // references
    await db.referee.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, name: "Professional Referee", relationship: "Colleague", organization: "Previous Org Ltd.", designation: "Manager", mobile: "01712" + String(Math.floor(Math.random() * 900000) + 100000), email: "ref1@example.com", type: "PROFESSIONAL", verificationStatus: "VERIFIED", verifiedAt: new Date() } })
    await db.referee.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, name: "Personal Referee", relationship: "Friend", organization: "Self", mobile: "01812" + String(Math.floor(Math.random() * 900000) + 100000), type: "PERSONAL" } })
    // previous employment (senior staff)
    if (gross > 40000) {
      await db.previousEmployment.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, company: "Meghna Retail Ltd.", designation: "Officer", department: "Operations", joinDate: dstr(2015, 1, 5), leaveDate: dstr(2019, 12, 30), lastSalary: Math.round(gross * 0.6), reasonForLeaving: "Career growth", supervisor: "Mr. Alam", contact: "01700000001" } })
    }
    // bank + MFS
    // F28 (P6) — demo PII encrypts at write time when a deployment key is
    // configured (best-effort: keyless dev seeds keep the legacy plaintext
    // rows, readable until scripts/encrypt-secrets-at-rest.ts rotates them).
    const salaryAcc = await db.bankAccount.create({
      data: {
        vendorId: emp.vendorId,
        employeeId: emp.id, holderName: s.name, bank: banks[Math.floor(Math.random() * banks.length)],
        branch: "Gulshan", accountNumber: seedPii("1" + String(Math.floor(Math.random() * 900000000) + 100000000)),
        routingNumber: "090" + String(Math.floor(Math.random() * 90000) + 10000), accountType: "SALARY",
        mfsProvider: ["BKASH", "NAGAD", "ROCKET"][Math.floor(Math.random() * 3)],
        mfsNumber: seedPii(s.mobile), paymentMethod: "BANK", isPrimary: true, verified: true,
        // 2026-10 payout round: designate this account as THE salary payout
        // account so the paid payroll run passes payout validation (the engine
        // requires a configured BANK payout for salaries above the threshold —
        // previously the demo corpus never configured it and payRun failed).
        isSalaryPayoutAccount: true,
      },
    })
    // configure the employee's payout method to match (BANK with the
    // designated account) — required by validatePayout in payRun.
    await db.employee.update({
      where: { id: emp.id },
      data: { salaryPayoutMethod: "BANK", salaryPayoutAccountId: salaryAcc.id } as any,
    })
    // documents
    await db.employeeDocument.create({
      data: { vendorId: finix.id, employeeId: emp.id, category: "IDENTITY", docType: "NID", title: "National ID Card", docNumber: seedPii(String(1990 + Math.floor(Math.random() * 15)) + String(Math.floor(Math.random() * 900000000) + 100000000)), nameOnDoc: s.name, issueDate: dstr(2016, 1, 10), expiryDate: Math.random() > 0.8 ? daysAgo(-20) : null, issuingAuthority: "Election Commission Bangladesh", status: "VALID", verified: true, verifiedBy: "seed", verifiedAt: new Date() },
    })
    await db.employeeDocument.create({
      data: { vendorId: finix.id, employeeId: emp.id, category: "EDUCATION", docType: "CERTIFICATE", title: "BBA Certificate", nameOnDoc: s.name, issueDate: dstr(2014, 6, 30), issuingAuthority: "University of Dhaka", status: "VALID", verified: Math.random() > 0.3 },
    })
    // leave balances
    for (const [ltCode, ltId] of Object.entries(leaveTypes)) {
      await db.leaveBalance.create({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
        data: { vendorId: finix.id, employeeId: emp.id, leaveTypeId: ltId, year: YEAR, entitled: ltDefs.find((x) => x[0] === ltCode)![3], used: 0, pending: 0, carriedForward: ["ANNUAL", "EARNED"].includes(ltCode) ? 2 : 0 },
      })
    }
  }
  // reporting structure
  const repMap: [string, string][] = [
    ["EMP-0002", "EMP-0001"], ["EMP-0003", "EMP-0002"], ["EMP-0004", "EMP-0003"], ["EMP-0005", "EMP-0002"],
    ["EMP-0006", "EMP-0005"], ["EMP-0007", "EMP-0002"], ["EMP-0008", "EMP-0007"], ["EMP-0009", "EMP-0008"],
    ["EMP-0010", "EMP-0021"], ["EMP-0011", "EMP-0012"], ["EMP-0012", "EMP-0007"], ["EMP-0013", "EMP-0002"],
    ["EMP-0014", "EMP-0013"], ["EMP-0015", "EMP-0013"], ["EMP-0016", "EMP-0002"], ["EMP-0017", "EMP-0002"],
    ["EMP-0018", "EMP-0013"], ["EMP-0019", "EMP-0021"], ["EMP-0020", "EMP-0008"], ["EMP-0021", "EMP-0007"],
    ["EMP-0022", "EMP-0005"], ["EMP-0023", "EMP-0003"], ["EMP-0024", "EMP-0012"],
  ]

  // ---- r8 legal audit (2026-10-14) — AIT tax-profile demo data ----
  // Exercises every §78/§163/surcharge path of the corrected engine:
  //   EMP-0002 (GM, female ৳1.2L gross): declared investment ৳1,50,000 → the
  //     §78(b) investment limb binds on the rebate
  //   EMP-0005 (AM): declared investment ৳60,000 (small — investment limb)
  //   EMP-0001 (MD, ৳2.2L gross): declared net worth ৳4.5 crore + 2 motor cars
  //     → the 10% net-wealth surcharge band AND the multiple-motor-car trigger
  //   EMP-0003: category "disabled" (৳5,25,000 threshold under FA 2026)
  //   EMP-0007: category "freedom_fighter" (৳5,50,000 threshold)
  // Female/senior thresholds are auto-suggested from gender/DOB by the engine.
  const aitDemo: { code: string; data: any }[] = [
    { code: "EMP-0002", data: { declaredInvestment: 150000 } },
    { code: "EMP-0005", data: { declaredInvestment: 60000 } },
    { code: "EMP-0001", data: { taxNetWealth: 45000000, taxMotorVehicles: 2 } },
    { code: "EMP-0003", data: { taxCategory: "disabled" } },
    { code: "EMP-0007", data: { taxCategory: "freedom_fighter" } },
  ]
  for (const d of aitDemo) {
    if (!empIds[d.code]) continue
    await db.employee.update({ where: { id: empIds[d.code] }, data: d.data })
  }
  for (const [emp, mgr] of repMap) {
    await db.employee.update({ where: { id: empIds[emp] }, data: { reportingManagerId: empIds[mgr] } })
  }
  // department heads + branch managers
  await db.department.update({ where: { id: depts["HR"] }, data: { headId: empIds["EMP-0003"] } })
  await db.department.update({ where: { id: depts["ACC"] }, data: { headId: empIds["EMP-0005"] } })
  await db.department.update({ where: { id: depts["SALES"] }, data: { headId: empIds["EMP-0007"] } })
  await db.department.update({ where: { id: depts["WH"] }, data: { headId: empIds["EMP-0013"] } })
  await db.branch.update({ where: { id: branches["ST01"] }, data: { managerId: empIds["EMP-0007"] } })
  await db.branch.update({ where: { id: branches["ST02"] }, data: { managerId: empIds["EMP-0021"] } })
  await db.branch.update({ where: { id: branches["WH01"] }, data: { managerId: empIds["EMP-0013"] } })
  await db.branch.update({ where: { id: branches["HO"] }, data: { managerId: empIds["EMP-0002"] } })
  console.log("✓ 24 curated employees with full 360° data, salary structures, leave balances")

  // ============ BULK TEST CORPUS — huge dummy data (env-tunable) ============
  // Deterministic, batched volume data for testing lists, filters, reports,
  // payroll volume and pagination. SEED_TEST_BULK_EMPLOYEES=0 skips this
  // entirely (classic curated demo corpus only).
  const bulkIds: string[] = []
  const bulkIdByCode = {} as Record<string, string>
  if (BULK_EMPLOYEES > 0) {
    const t0 = Date.now()
    const desigRows = await db.designation.findMany({ where: { vendorId: finix.id }, select: { id: true, code: true, departmentId: true, grade: true, minSalary: true, maxSalary: true } })
    const deptRows = await db.department.findMany({ where: { vendorId: finix.id }, select: { id: true, code: true, branchId: true } })
    const branchByDept = new Map(deptRows.map((d) => [d.id, d.branchId]))
    const deptHead = new Map<string, string>()
    for (const [dcode, did] of Object.entries(depts)) {
      const head = dcode === "HR" ? empIds["EMP-0003"] : dcode === "ACC" ? empIds["EMP-0005"]
        : dcode === "SALES" ? empIds["EMP-0007"] : dcode === "WH" ? empIds["EMP-0013"] : empIds["EMP-0002"]
      deptHead.set(did, head)
    }
    const shiftOfDept = (deptCode: string) =>
      ["SALES", "CS"].includes(deptCode) ? (rnd() < 0.5 ? shifts["MOR"] : shifts["EVE"])
        : ["WH", "INV", "DLV"].includes(deptCode) ? (rnd() < 0.75 ? shifts["GEN"] : shifts["NGT"])
          : shifts["GEN"]
    const FIRST_M = ["Arif", "Sajid", "Rakib", "Naeem", "Tanjim", "Shakib", "Jubayer", "Mehedi", "Rifat", "Ashraful", "Naimul", "Sabbir", "Fahim", "Tamim", "Rasel", "Jewel", "Milon", "Habib", "Sohag", "Asad"]
    const FIRST_F = ["Sumaiya", "Nabila", "Tahmina", "Rumana", "Sadia", "Farzana", "Maliha", "Ishrat", "Sabnam", "Rezwana", "Mahmuda", "Salma", "Nasrin", "Shapla", "Dilruba", "Ayesha", "Tania", "Moushumi", "Priya", "Lamia"]
    const LAST = ["Islam", "Hossain", "Rahman", "Ahmed", "Khan", "Chowdhury", "Akter", "Begum", "Sultana", "Mia", "Sarker", "Das", "Barman", "Talukder", "Haque", "Siddique", "Mahmud", "Uddin", "Alam", "Bhuiyan"]
    const BLOOD = ["A+", "B+", "O+", "AB+", "A-", "B-"]
    const BANKS = ["BRAC Bank", "Dutch-Bangla Bank", "City Bank", "Eastern Bank", "Islami Bank", "Prime Bank"]
    const DEGREES: [string, string, string][] = [["BBA", "Business Administration", "University of Dhaka"], ["BSc", "Computer Science", "BUET"], ["BA", "English", "Jahangirnagar University"], ["BCom", "Accounting", "Chittagong University"]]

    type BulkEmp = { code: string; name: string; gender: string; deptId: string; desigId: string; grade: string; gross: number; joining: string; dob: string; type: string; status: string }
    const bulkPlan: BulkEmp[] = []
    const desigsWithDept = desigRows.filter((d) => d.departmentId)
    for (let i = 1; i <= BULK_EMPLOYEES; i++) {
      const code = `EMP-${1000 + i}`
      const gender = rnd() < 0.62 ? "Male" : "Female"
      const name = `${gender === "Male" ? pick(FIRST_M) : pick(FIRST_F)} ${pick(LAST)}`
      const desig = pick(desigsWithDept)
      const dMin = desig.minSalary ?? 15000
      const dMax = Math.max(dMin, desig.maxSalary ?? dMin * 2)
      const gross = Math.round((dMin + rnd() * (dMax - dMin)) / 500) * 500
      const r = rnd()
      const type = r < 0.8 ? "PERMANENT" : r < 0.92 ? "PROBATIONARY" : "CONTRACTUAL"
      const status = type === "PROBATIONARY" ? "PROBATION" : r < 0.97 ? "ACTIVE" : "ON_LEAVE"
      bulkPlan.push({
        code, name, gender,
        deptId: desig.departmentId as string, desigId: desig.id, grade: desig.grade || "C",
        gross: Math.max(14000, gross),
        joining: iso(new Date(NOW.getTime() - ri(60, 2920) * 86400000)),
        dob: dstr(ri(1975, 2003), ri(1, 12), ri(1, 28)),
        type, status,
      })
    }

    // employees — batched createMany (100/batch), then map code→id
    for (let i = 0; i < bulkPlan.length; i += 100) {
      await db.employee.createMany({
        data: bulkPlan.slice(i, i + 100).map((p) => {
          const [first, ...rest] = p.name.split(" ")
          const last = rest.join(" ")
          const codeSuffix = p.code.slice(4)
          const branchId = branchByDept.get(p.deptId) || branches["HO"]
          return {
            vendorId: finix.id, code: p.code, fullName: p.name,
            preferredName: first, fatherName: `Md. ${last}`, motherName: `Mrs. ${first}${pick(LAST)}`,
            dob: p.dob, placeOfBirth: pick(["Dhaka", "Chattogram", "Sylhet", "Khulna", "Rajshahi", "Barishal"]),
            gender: p.gender, bloodGroup: pick(BLOOD),
            maritalStatus: p.dob < "1995" ? "Married" : rnd() < 0.5 ? "Single" : "Married",
            nationality: "Bangladeshi", religion: rnd() < 0.92 ? "Islam" : "Hinduism",
            mobile: `018${String(10000000 + Number(codeSuffix))}`, altMobile: null,
            personalEmail: `${first.toLowerCase()}.${last.toLowerCase()}.${codeSuffix}@gmail.com`,
            officialEmail: `${first.toLowerCase()}.${last.toLowerCase()}.${codeSuffix}@bengaltextworks.example`,
            emergencyName: "Family Contact", emergencyRelation: "Relative", emergencyMobile: `019${String(10000000 + Number(codeSuffix))}`,
            presentAddress: `House ${ri(1, 90)}, Road ${ri(1, 20)}, Dhanmondi, Dhaka`,
            permanentAddress: `Village: Charpara, P.O: Sadar, Dist: ${pick(["Dhaka", "Chattogram", "Sylhet", "Khulna", "Rajshahi"])}`,
            division: "Dhaka", district: pick(["Dhaka", "Chattogram", "Sylhet", "Khulna", "Rajshahi"]), city: "Dhaka", postCode: `120${ri(10, 99)}`,
            presentDivision: "Dhaka", presentDistrict: "Dhaka", presentCity: "Dhaka", presentPostCode: `120${ri(10, 99)}`,
            addressSame: rnd() > 0.7,
            branchId, departmentId: p.deptId, designationId: p.desigId,
            reportingManagerId: deptHead.get(p.deptId) || empIds["EMP-0002"],
            workLocation: "HO", joiningDate: p.joining,
            probationMonths: p.type === "PROBATIONARY" ? 6 : 3,
            employmentType: p.type, status: p.status, category: "Staff", grade: p.grade,
            shiftId: shiftOfDept(deptRows.find((d) => d.id === p.deptId)?.code || ""), weeklyOff: "FRIDAY",
            contractStart: p.type === "CONTRACTUAL" ? p.joining : null,
            contractEnd: p.type === "CONTRACTUAL" ? iso(new Date(new Date(p.joining).getTime() + 365 * 86400000)) : null,
          }
        }),
      })
    }
    const created = await db.employee.findMany({ where: { vendorId: finix.id, code: { startsWith: "EMP-1" } }, select: { id: true, code: true } })
    for (const c of created) { bulkIds.push(c.id); bulkIdByCode[c.code] = c.id }
    const planByCode = new Map(bulkPlan.map((p) => [p.code, p]))
    // safe accessor — every created employee must have its generation plan
    const planOf = (code: string): BulkEmp => {
      const p = planByCode.get(code)
      if (!p) throw new Error(`bulk plan missing for ${code}`)
      return p
    }

    // joined history
    await db.employeeHistory.createMany({
      data: created.map((c) => ({ vendorId: finix.id, employeeId: c.id, eventType: "JOINED", title: "Joined the organization", effectiveDate: planOf(c.code).joining })),
    })
    // salary structures (same component split as the curated cast)
    await db.salaryStructure.createMany({
      data: created.map((c) => {
        const gross = planOf(c.code).gross
        return {
          vendorId: finix.id, employeeId: c.id, effectiveFrom: planOf(c.code).joining,
          basic: Math.round(gross * 0.5), houseRent: Math.round(gross * 0.2), medical: Math.round(gross * 0.08),
          conveyance: Math.round(gross * 0.06), food: Math.round(gross * 0.05), mobileAllow: Math.round(gross * 0.04),
          internetAllow: Math.round(gross * 0.03), attendanceAllow: Math.round(gross * 0.02), otherAllowance: Math.round(gross * 0.02),
          gross, status: "ACTIVE",
        }
      }),
    })
    // bank accounts (designated salary payout accounts, like the curated cast)
    await db.bankAccount.createMany({
      data: created.map((c) => ({
        vendorId: finix.id,
        employeeId: c.id, holderName: planOf(c.code).name, bank: pick(BANKS),
        branch: pick(["Gulshan", "Dhanmondi", "Uttara", "Motijheel"]),
        accountNumber: seedPii(`2${String(200000000 + Number(c.code.slice(4)))}`),
        routingNumber: `090${String(10000 + ri(0, 89999))}`, accountType: "SALARY",
        mfsProvider: pick(["BKASH", "NAGAD", "ROCKET"]),
        mfsNumber: seedPii(`018${String(10000000 + Number(c.code.slice(4)))}`),
        paymentMethod: "BANK", isPrimary: true, verified: true, isSalaryPayoutAccount: true,
      })),
    })
    // link payout accounts (small loop — one update per employee)
    const bulkAccounts = await db.bankAccount.findMany({ where: { employeeId: { in: bulkIds }, accountType: "SALARY" }, select: { id: true, employeeId: true } })
    for (const acc of bulkAccounts) {
      await db.employee.update({ where: { id: acc.employeeId }, data: { salaryPayoutMethod: "BANK", salaryPayoutAccountId: acc.id } as any })
    }
    // family (spouse for married, one child for most)
    await db.familyMember.createMany({
      data: created.flatMap((c) => {
        const p = planOf(c.code)
        const rows: any[] = [{ vendorId: finix.id, employeeId: c.id, name: `Spouse of ${p.name}`, relationship: "Spouse", gender: p.gender === "Male" ? "Female" : "Male", dependent: true }]
        if (rnd() < 0.7) rows.push({ vendorId: finix.id, employeeId: c.id, name: `Child of ${p.name}`, relationship: "Child", dob: dstr(ri(2015, 2023), 3, 5), gender: "Male", dependent: true })
        return rows
      }),
    })
    // education (one degree each)
    await db.education.createMany({
      data: created.map((c) => {
        const [degree, major, institution] = pick(DEGREES)
        return { vendorId: finix.id, employeeId: c.id, degree, examination: "Bachelor", institution, board: "NU", major, passingYear: String(ri(2010, 2025)), result: (3 + rnd()).toFixed(2) }
      }),
    })
    // NID documents
    await db.employeeDocument.createMany({
      data: created.map((c) => {
        const p = planOf(c.code)
        return { vendorId: finix.id, employeeId: c.id, category: "IDENTITY", docType: "NID", title: "National ID Card", docNumber: seedPii(String(ri(1990, 2005)) + String(ri(100000000, 999999999))), nameOnDoc: p.name, issueDate: dstr(2016, 1, 10), issuingAuthority: "Election Commission Bangladesh", status: "VALID", verified: rnd() > 0.25, verifiedBy: "seed", verifiedAt: new Date() }
      }),
    })
    // leave balances (all 8 statutory types)
    const ltRows = await db.leaveType.findMany({ where: { vendorId: finix.id }, select: { id: true, code: true, defaultDays: true } })
    await db.leaveBalance.createMany({
      data: created.flatMap((c) => ltRows.map((lt) => ({
        vendorId: finix.id, employeeId: c.id, leaveTypeId: lt.id, year: YEAR,
        entitled: lt.defaultDays, used: 0, pending: 0,
        carriedForward: ["ANNUAL", "EARNED"].includes(lt.code) ? ri(0, 5) : 0,
      }))),
    })
    // ESS login accounts for load testing (linked to the first N bulk employees)
    if (BULK_USERS > 0) {
      const n = Math.min(BULK_USERS, created.length)
      await db.user.createMany({
        data: created.slice(0, n).map((c, idx) => ({
          vendorId: finix.id, email: `loadtest${String(idx + 1).padStart(3, "0")}@bengaltextworks.example`,
          name: `${planOf(c.code).name} (Load Test)`, passwordHash: hashPassword(SEED_PASSWORD),
          role: "EMPLOYEE", employeeId: c.id, status: "ACTIVE", passwordChangedAt: new Date(0),
        })),
      })
    }
    console.log(`✓ BULK TEST CORPUS: ${created.length} employees + histories/structures/banks/family/education/NID/leave balances${BULK_USERS > 0 ? ` + ${Math.min(BULK_USERS, created.length)} ESS load-test users` : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

    // 2026-10-14 — directory status demo: a small deterministic slice of the
    // bulk corpus is off-active (INACTIVE archived / SUSPENDED / RESIGNED /
    // TERMINATED / RETIRED) so the Employee Directory's FULL status filter
    // chip row — including the previously unreachable Inactive tab — has data
    // to demonstrate. Flipped BEFORE attendance/payroll so the off-active
    // employees generate no current activity (they are archived, not active).
    {
      const flipCodes = Object.keys(bulkIdByCode)
      const flips: [number, string, string][] = [
        [3, "INACTIVE", "Archived — long unauthorized absence"],
        [9, "INACTIVE", "Archived — end of contract"],
        [17, "SUSPENDED", "Suspended pending investigation"],
        [25, "RESIGNED", "Resigned — relocated abroad"],
        [31, "TERMINATED", "Terminated — policy violation"],
        [39, "RETIRED", "Retired after service completion"],
      ]
      let flipped = 0
      for (const [idx, status, note] of flips) {
        const id = flipCodes[idx] ? bulkIdByCode[flipCodes[idx]] : undefined
        if (!id) continue
        await db.employee.update({ where: { id }, data: { status } })
        await db.employeeHistory.create({ data: { vendorId: finix.id, employeeId: id, eventType: "STATUS_CHANGE", title: `Status → ${status.charAt(0)}${status.slice(1).toLowerCase()}`, description: note, effectiveDate: daysAgo(ri(5, 60)) } })
        flipped++
      }
      console.log(`✓ directory status demo: ${flipped} bulk employees set to INACTIVE / SUSPENDED / RESIGNED / TERMINATED / RETIRED`)
    }
  }

  // ============ USERS (one per role) ============
  const userDefs: [string, string, string, string, string][] = [
    ["owner@bengaltextworks.example", "Nazmul Hasan (Owner)", "VENDOR_OWNER", SEED_PASSWORD, "EMP-0001"],
    ["admin@bengaltextworks.example", "Rashedul Islam (HR Admin)", "HR_ADMIN", SEED_PASSWORD, "EMP-0003"],
    ["hr@bengaltextworks.example", "Nusrat Jahan (HR Manager)", "HR_MANAGER", SEED_PASSWORD, "EMP-0004"],
    ["payroll@bengaltextworks.example", "Kamrul Hasan (Payroll)", "PAYROLL_OFFICER", SEED_PASSWORD, "EMP-0005"],
    ["branch@bengaltextworks.example", "Mahbubur Rahman (Branch Mgr)", "BRANCH_MANAGER", SEED_PASSWORD, "EMP-0007"],
    ["branch2@bengaltextworks.example", "Anisur Rahman (Branch Mgr)", "BRANCH_MANAGER", SEED_PASSWORD, "EMP-0021"],
    ["dept@bengaltextworks.example", "Abdul Karim (Dept Mgr)", "DEPT_MANAGER", SEED_PASSWORD, "EMP-0013"],
    ["employee@bengaltextworks.example", "Rahim Miah (ESS)", "EMPLOYEE", SEED_PASSWORD, "EMP-0009"],
    ["employee2@bengaltextworks.example", "Shirin Sultana (ESS)", "EMPLOYEE", SEED_PASSWORD, "EMP-0010"],
  ]
  for (const [email, name, role, pass, empCode] of userDefs) {
    await db.user.create({
      data: {
        vendorId: finix.id, email, name, passwordHash: hashPassword(pass), role,
        employeeId: empIds[empCode],
        branchId: role === "BRANCH_MANAGER" ? (email.includes("branch2") ? branches["ST02"] : branches["ST01"]) : null,
        departmentId: role === "DEPT_MANAGER" ? depts["WH"] : null,
        status: "ACTIVE",
        // C-02 — seeded credentials travel in a public artifact: force rotation
        // on first login (passwordChangedAt=epoch + policy expiryDays=90 below).
        passwordChangedAt: new Date(0),
      },
    })
  }
  // vendor 2 users
  await db.user.create({ data: { vendorId: rongin.id, email: "owner@rongintraders.com", name: "Rongin Owner", passwordHash: hashPassword(SEED_PASSWORD), role: "VENDOR_OWNER", status: "ACTIVE", passwordChangedAt: new Date(0) } })
  await db.user.create({ data: { vendorId: rongin.id, email: "employee@rongintraders.com", name: "Rongin Employee", passwordHash: hashPassword(SEED_PASSWORD), role: "EMPLOYEE", status: "ACTIVE", passwordChangedAt: new Date(0) } })
  // a couple more employees for vendor 2 (to prove isolation)
  const ronginBranch = await db.branch.create({ data: { vendorId: rongin.id, code: "R1", name: "Rongin Head Office", type: "OFFICE", active: true } })
  const ronginDept = await db.department.create({ data: { vendorId: rongin.id, code: "RD1", name: "Operations", status: "ACTIVE" } })
  const ronginDesig = await db.designation.create({ data: { vendorId: rongin.id, code: "RD", name: "Operations Officer", status: "ACTIVE" } })
  const ronginEmp = await db.employee.create({
    data: { vendorId: rongin.id, code: "RT-0001", fullName: "Rongin Staff One", mobile: "01799887766", dob: dstr(1995, 5, 5), gender: "Male", branchId: ronginBranch.id, departmentId: ronginDept.id, designationId: ronginDesig.id, joiningDate: dstr(2024, 1, 1), employmentType: "PERMANENT", status: "ACTIVE" },
  })
  await db.user.update({ where: { vendorId_email: { vendorId: rongin.id, email: "employee@rongintraders.com" } }, data: { employeeId: ronginEmp.id } })
  await db.salaryStructure.create({ data: { vendorId: rongin.id, employeeId: ronginEmp.id, effectiveFrom: dstr(2024, 1, 1), basic: 15000, houseRent: 5000, medical: 2000, conveyance: 1000, gross: 23000, status: "ACTIVE" } })
  console.log(`✓ role users (9 Finix + 2 Rongin across all roles${BULK_USERS > 0 && bulkIds.length > 0 ? ` + ${Math.min(BULK_USERS, bulkIds.length)} bulk ESS load-test accounts` : ""})`)

  // C-02 — password-rotation policy for seeded credentials: 90-day expiry +
  // passwordChangedAt=epoch (set above) forces every seeded account through
  // the mandatory change-password flow on its FIRST login (auth.ts HRM-007).
  // The reset() above also purged the Session table, so no live admin
  // sessions ship with the seeded database.
  for (const v of [finix.id, rongin.id]) {
    await db.hrSetting.upsert({
      where: { vendorId_group_key: { vendorId: v, group: "passwordPolicy", key: "expiryDays" } },
      create: { vendorId: v, group: "passwordPolicy", key: "expiryDays", value: "90" },
      update: { value: "90" },
    })
  }
  console.log("✓ password policy (90-day expiry — seeded accounts rotate on first login)")

  // C-03 update — device gateway policy: the demo terminals above are seeded
  // WITHOUT comm keys, so "Allow Keyless Devices" is seeded ON for the demo
  // vendors to keep their pushes flowing (mirrors the pre-update demo behavior
  // inside the old grace window). The production default is OFF (secure) —
  // flip it per vendor in Settings → Devices.
  for (const v of [finix.id, rongin.id]) {
    await db.hrSetting.upsert({
      where: { vendorId_group_key: { vendorId: v, group: "devices", key: "allowKeyless" } },
      create: { vendorId: v, group: "devices", key: "allowKeyless", value: "true" },
      update: { value: "true" },
    })
  }
  console.log("✓ device security (keyless demo devices allowed — Settings → Devices)")

  // ============ ATTENDANCE HISTORY (batched — full workforce, huge volume) ============
  const seedCtx = { userId: "seed", userName: "Seeder", vendorId: finix.id, role: "HR_ADMIN", permissions: new Set<string>(), ip: undefined } as unknown as Ctx
  const { upsertForSeed } = await import("./seed-helpers")

  {
    const t0 = Date.now()
    const allShifts = await db.shift.findMany({ where: { vendorId: finix.id } })
    const shiftById = new Map(allShifts.map((s) => [s.id, s]))
    const activeEmps = await db.employee.findMany({
      where: { vendorId: finix.id, status: { in: ["ACTIVE", "PROBATION"] } },
      select: { id: true, shiftId: true },
    })
    // generate in memory (deterministic), then batch-insert with skipDuplicates
    const attRows: any[] = []
    const from = new Date(NOW.getTime() - (ATTENDANCE_DAYS - 1) * 86400000)
    for (const emp of activeEmps) {
      const shift = emp.shiftId ? shiftById.get(emp.shiftId) : undefined
      const startMin = shift ? toMin(shift.startTime) : 540
      const endMin = shift ? toMin(shift.endTime) : 1080
      for (let d = new Date(from); d < NOW; d.setDate(d.getDate() + 1)) {
        const date = iso(d)
        if (d.getDay() === 5) continue // Friday off
        const rand = rnd()
        if (rand < 0.03) {
          attRows.push({ vendorId: finix.id, employeeId: emp.id, date, shiftId: emp.shiftId, status: "ABSENT", source: "BIOMETRIC" })
          continue
        }
        if (rand < 0.055) {
          attRows.push({ vendorId: finix.id, employeeId: emp.id, date, shiftId: emp.shiftId, status: "LEAVE", source: "MANUAL", remarks: "Bulk corpus leave" })
          continue
        }
        const checkIn = toHHMM(startMin + ri(-12, 28))
        const r2 = rnd()
        const checkOut = r2 < 0.1 ? toHHMM(endMin - 45)
          : r2 < 0.2 ? toHHMM(endMin + 20 + ri(0, 90))
            : toHHMM(endMin + ri(0, 15))
        const calc = computeAttendance(shift, checkIn, checkOut)
        attRows.push({
          vendorId: finix.id, employeeId: emp.id, date, shiftId: emp.shiftId,
          checkIn, checkOut, workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
          earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes,
          status: calc.status, source: "BIOMETRIC", deviceInfo: "ZK-U550",
        })
      }
    }
    let inserted = 0
    for (let i = 0; i < attRows.length; i += 2000) {
      const r = await db.attendance.createMany({ data: attRows.slice(i, i + 2000), skipDuplicates: true })
      inserted += r.count
    }
    // a couple of geo-fence / web check-ins today (curated demo rows)
    const webEmp = empIds["EMP-0009"]
    await upsertForSeed(seedCtx, { employeeId: webEmp, date: TODAY, checkIn: toHHMM(9 * 60 + 3) }, "WEB")
    const geoEmp = empIds["EMP-0010"]
    await upsertForSeed(seedCtx, { employeeId: geoEmp, date: TODAY, checkIn: toHHMM(8 * 60 + 55) }, "GEOFENCE")
    console.log(`✓ attendance history: ${inserted.toLocaleString()} rows / ${activeEmps.length.toLocaleString()} employees / ${ATTENDANCE_DAYS} days (batched, ${((Date.now() - t0) / 1000).toFixed(1)}s) + web/geo-fence demos`)
  }

// biometric devices — ZKTeco ADMS push integration (SenseFace 3A primary)
const devHO = await db.attendanceDevice.create({ data: { vendorId: finix.id, deviceId: "SF3A-HO-01", name: "Head Office — SenseFace 3A", branchId: branches["HO"], manufacturer: "ZKTeco", model: "SenseFace 3A", location: "HO main entrance", protocol: "ADMS", deviceIdentifier: "CJXR251860053", serialNumber: "CJXR251860053", timezone: "Asia/Dhaka", enabled: true, status: "ONLINE", lastSeenAt: new Date(Date.now() - 45_000), lastSyncAt: new Date(Date.now() - 45_000), pushVersion: "5.1.0", ipAddress: "192.168.1.201" } })
const devST = await db.attendanceDevice.create({ data: { vendorId: finix.id, deviceId: "SF3A-ST-01", name: "Dhanmondi Store — SenseFace 3A", branchId: branches["ST01"], manufacturer: "ZKTeco", model: "SenseFace 3A", location: "Store entrance", protocol: "ADMS", deviceIdentifier: "CJXR251860061", serialNumber: "CJXR251860061", timezone: "Asia/Dhaka", enabled: true, status: "ONLINE", lastSeenAt: new Date(Date.now() - 90_000), ipAddress: "192.168.1.145" } })
const devWH = await db.attendanceDevice.create({ data: { vendorId: finix.id, deviceId: "SFV5-WH-01", name: "Warehouse — SpeedFace V5L", branchId: branches["WH01"], manufacturer: "ZKTeco", model: "SpeedFace V5L", location: "Warehouse gate", protocol: "ADMS", deviceIdentifier: "A8R3N11220042", serialNumber: "A8R3N11220042", timezone: "Asia/Dhaka", enabled: true, status: "OFFLINE", lastSeenAt: new Date(Date.now() - 3 * 86400000), lastError: "No push received for 3 days" } })
await db.attendanceDevice.create({ data: { vendorId: rongin.id, deviceId: "K40-RNG-01", name: "Rongin Office — K40", manufacturer: "ZKTeco", model: "K40", location: "Office entrance", protocol: "ADMS", deviceIdentifier: "RNGK40-2210071", serialNumber: "RNGK40-2210071", enabled: true, status: "OFFLINE" } })

// employee ↔ device mappings (device PIN = numeric suffix of employee code, per device)
const finixEmps = await db.employee.findMany({ where: { vendorId: finix.id }, select: { id: true, code: true, branchId: true, status: true } })
let mappedCount = 0
{
  const mapRows = finixEmps
    .filter((e) => ["ACTIVE", "PROBATION"].includes(e.status))
    .map((e) => {
      const dev = e.branchId === branches["ST01"] ? devST : e.branchId === branches["WH01"] ? devWH : e.branchId === branches["HO"] ? devHO : null
      if (!dev) return null
      return { vendorId: finix.id, deviceId: dev.id, employeeId: e.id, deviceUserId: String(Number(e.code.slice(4))), lastSyncedAt: new Date() }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  for (let i = 0; i < mapRows.length; i += 500) {
    await db.attendanceDeviceUser.createMany({ data: mapRows.slice(i, i + 500), skipDuplicates: true })
  }
  mappedCount = mapRows.length
}

// raw device events — pushed through the REAL processing pipeline
const evT = (h: number, m: number) => `${TODAY} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`
const evTY = (h: number, m: number) => `${daysAgo(1)} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`
const STATUS_OF: Record<number, "IN" | "OUT" | "AUTO"> = { 0: "IN", 1: "OUT" }
async function pushEvent(dev: any, pin: string, time: string, status: number, verify = 3) {
  const rawLine = [pin, verify, time, status, 0, 0, 0].join("\t")
  const fp = fingerprint(dev.deviceIdentifier, { deviceSerial: dev.deviceIdentifier, deviceUserId: pin, eventTime: time, verifyMode: verify, attendanceStatus: status, workCode: null, eventType: STATUS_OF[status] || "AUTO", rawLine })
  const ev = await db.attendanceRawEvent.create({ data: { vendorId: finix.id, deviceId: dev.id, deviceSerial: dev.deviceIdentifier, deviceUserId: pin, eventTime: time, verifyMode: verify, attendanceStatus: status, eventType: STATUS_OF[status] || "AUTO", rawLine, payloadHash: fp, processingStatus: "RECEIVED" } })
  return mapAndProcessEvent(ev as any)
}

const noDevice = new Set(["EMP-0009", "EMP-0010"]) // keep their web / geo-fence demo rows untouched
const hoEmps = finixEmps.filter((e) => e.branchId === branches["HO"] && ["ACTIVE", "PROBATION"].includes(e.status) && !noDevice.has(e.code))
const stEmps = finixEmps.filter((e) => e.branchId === branches["ST01"] && ["ACTIVE", "PROBATION"].includes(e.status) && !noDevice.has(e.code))
const hoTimes = [[8, 52], [8, 58], [9, 6], [8, 49], [9, 14], [8, 55], [9, 1], [8, 47]]
let hoEvents = 0
for (let i = 0; i < Math.min(hoTimes.length, hoEmps.length); i++) {
  const pin = String(Number(hoEmps[i].code.slice(4)))
  await pushEvent(devHO, pin, evT(hoTimes[i][0], hoTimes[i][1]), 0)
  hoEvents++
}
if (hoEmps.length > 2) { // one employee already out (errand)
  await pushEvent(devHO, String(Number(hoEmps[2].code.slice(4))), evT(9, 58), 1)
  hoEvents++
}
// store device: yesterday full day + today morning
let stEvents = 0
for (let i = 0; i < Math.min(3, stEmps.length); i++) {
  const pin = String(Number(stEmps[i].code.slice(4)))
  await pushEvent(devST, pin, evTY(10, 4 + i), 0)
  await pushEvent(devST, pin, evTY(21, 2 + i * 3), 1)
  await pushEvent(devST, pin, evT(10, 1 + i * 2), 0)
  stEvents += 3
}
// unknown device users (PIN 9001/9002) — retained, awaiting mapping
await pushEvent(devHO, "9001", evTY(8, 51), 0)
await pushEvent(devHO, "9001", evT(9, 2), 0)
await pushEvent(devHO, "9002", evT(10, 15), 0)
await db.attendanceDevice.update({ where: { id: devHO.id }, data: { eventCount: hoEvents + 3, lastAttendanceAt: new Date(Date.now() - 20 * 60000) } })
await db.attendanceDevice.update({ where: { id: devST.id }, data: { eventCount: stEvents, lastAttendanceAt: new Date(Date.now() - 55 * 60000) } })

// device communication log samples
await db.deviceCommLog.createMany({ data: [
  { vendorId: finix.id, deviceId: devHO.id, serial: "CJXR251860053", endpoint: "/api/integrations/zkteco/adms/cdata", requestType: "HANDSHAKE", httpStatus: 200, durationMs: 12, ip: "192.168.1.201", createdAt: new Date(Date.now() - 50_000) },
  { vendorId: finix.id, deviceId: devHO.id, serial: "CJXR251860053", endpoint: "/api/integrations/zkteco/adms/cdata", requestType: "ATTLOG", httpStatus: 200, eventCount: hoEvents, durationMs: 38, ip: "192.168.1.201", createdAt: new Date(Date.now() - 45_000) },
  { vendorId: finix.id, deviceId: devST.id, serial: "CJXR251860061", endpoint: "/api/integrations/zkteco/adms/cdata", requestType: "HANDSHAKE", httpStatus: 200, durationMs: 15, ip: "192.168.1.145", createdAt: new Date(Date.now() - 95_000) },
  { vendorId: finix.id, deviceId: devST.id, serial: "CJXR251860061", endpoint: "/api/integrations/zkteco/adms/cdata", requestType: "ATTLOG", httpStatus: 200, eventCount: stEvents, durationMs: 31, ip: "192.168.1.145", createdAt: new Date(Date.now() - 90_000) },
  { vendorId: finix.id, serial: "UNKNOWN-SN-1", endpoint: "/api/integrations/zkteco/adms/cdata", requestType: "REJECTED", httpStatus: 404, ok: false, error: "Unknown device UNKNOWN-SN-1 — register it in HRM first", ip: "203.0.113.9", createdAt: new Date(Date.now() - 3600_000) },
] })
console.log(`✓ ADMS devices (4), mappings (${mappedCount}), raw events (${hoEvents + stEvents + 3} incl. 3 unknown)`)

  // ============ LEAVE REQUESTS ============
  const leaveReqSeeds: [string, string, string, string, string][] = [
    ["EMP-0009", "SICK", daysAgo(2), TODAY, "Fever and cold — medical rest advised"],
    ["EMP-0012", "CASUAL", daysAgo(-3), daysAgo(-1), "Family occasion at hometown"],
    ["EMP-0014", "ANNUAL", daysAgo(-10), daysAgo(-6), "Annual vacation"],
    ["EMP-0019", "CASUAL", daysAgo(-2), daysAgo(-1), "Personal work"],
    ["EMP-0020", "SICK", daysAgo(5), daysAgo(4), "Medical checkup"],
    // LVE-001 (R3-4) — an UNPAID-type request so approving it exercises the
    // LEAVE_UNPAID attendance + LWP-days → absenceDeduction money path
    ["EMP-0013", "UNPAID", daysAgo(-6), daysAgo(-4), "Higher-study exam preparation — unpaid leave"],
  ]
  for (const [code, lt, from, to, reason] of leaveReqSeeds) {
    const days = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1)
    const isPast = to < TODAY
    await db.leaveRequest.create({
      data: {
        vendorId: finix.id, employeeId: empIds[code], leaveTypeId: leaveTypes[lt],
        fromDate: from, toDate: to, days, reason, status: isPast ? "APPROVED" : "PENDING",
        actedBy: isPast ? "seed" : null, actedAt: isPast ? new Date() : null,
      },
    })
    if (isPast) {
      const bal = await db.leaveBalance.findFirst({ where: { employeeId: empIds[code], leaveTypeId: leaveTypes[lt], year: YEAR } })
      if (bal) await db.leaveBalance.update({ where: { id: bal.id }, data: { used: bal.used + days } })
      let d = from
      while (d <= to) {
        const dow = new Date(d + "T00:00:00").getDay()
        if (dow !== 5) {
          await db.attendance.upsert({
            where: { vendorId_employeeId_date: { vendorId: finix.id, employeeId: empIds[code], date: d } },
            create: { vendorId: finix.id, employeeId: empIds[code], date: d, status: "LEAVE", source: "MANUAL", remarks: "Approved leave" },
            update: { status: "LEAVE" },
          })
        }
        // addDays advances the calendar date in every timezone; the old
        // "local midnight + 24h in ms, sliced to ISO" never advanced past the
        // first date on machines east of UTC (Asia/Dhaka +6) → infinite loop.
        d = addDays(d, 1)
      }
    } else {
      const bal = await db.leaveBalance.findFirst({ where: { employeeId: empIds[code], leaveTypeId: leaveTypes[lt], year: YEAR } })
      if (bal) await db.leaveBalance.update({ where: { id: bal.id }, data: { pending: bal.pending + days } })
    }
  }
  // one pending leave with substitute pending acceptance
  await db.leaveRequest.create({
    data: { vendorId: finix.id, employeeId: empIds["EMP-0011"], leaveTypeId: leaveTypes["CASUAL"], fromDate: daysAgo(-7), toDate: daysAgo(-5), days: 3, reason: "Sister's wedding", substituteEmployeeId: empIds["EMP-0012"], substituteStatus: "PENDING", status: "PENDING" },
  })
  console.log("✓ leave requests (approved + pending + substitute flow)")

  // ---- BULK TEST CORPUS: leave requests (~12% of bulk workforce) ----
  if (bulkIds.length > 0) {
    const t0 = Date.now()
    const ltAll = await db.leaveType.findMany({ where: { vendorId: finix.id }, select: { id: true, code: true } })
    const ltByCode = new Map(ltAll.map((l) => [l.code, l.id]))
    const bulkCodes = Object.keys(bulkIdByCode)
    const nLeave = Math.max(1, Math.round(bulkIds.length * 0.12))
    const leaveRows: any[] = []
    const approvedForBalance: { empId: string; ltId: string; days: number; from: string; to: string }[] = []
    for (let i = 0; i < nLeave; i++) {
      const code = bulkCodes[i % bulkCodes.length]
      const ltCode = pick(["CASUAL", "SICK", "ANNUAL", "EMERGENCY"])
      const ltId = ltByCode.get(ltCode)
      if (!ltId) continue
      const days = ri(1, Math.min(5, ltCode === "ANNUAL" ? 5 : 3))
      const past = rnd() < 0.55
      const from = past ? daysAgo(ri(days + 1, 60)) : daysAgo(-ri(1, 20))
      // timezone-safe calendar advance (iso() of local-midnight + 24h*ms gets
      // stuck on the same date east of UTC — see leave loops above)
      const to = addDays(from, days - 1)
      leaveRows.push({
        vendorId: finix.id, employeeId: bulkIdByCode[code], leaveTypeId: ltId,
        fromDate: from, toDate: to, days,
        reason: pick(["Family matter", "Medical rest advised", "Personal work at hometown", "Wedding in family", "Urgent errand"]),
        status: past ? "APPROVED" : "PENDING",
        actedBy: past ? "seed" : null, actedAt: past ? new Date() : null,
      })
      if (past) approvedForBalance.push({ empId: bulkIdByCode[code], ltId, days, from, to })
    }
    await db.leaveRequest.createMany({ data: leaveRows })
    // keep balances + attendance consistent for the approved historical ones
    for (const a of approvedForBalance) {
      await db.leaveBalance.updateMany({
        where: { employeeId: a.empId, leaveTypeId: a.ltId, year: YEAR },
        data: { used: { increment: a.days } },
      })
      let d = a.from
      while (d <= a.to) {
        const dow = new Date(d + "T00:00:00").getDay()
        if (dow !== 5) {
          await db.attendance.upsert({
            where: { vendorId_employeeId_date: { vendorId: finix.id, employeeId: a.empId, date: d } },
            create: { vendorId: finix.id, employeeId: a.empId, date: d, status: "LEAVE", source: "MANUAL", remarks: "Approved leave (bulk)" },
            update: { status: "LEAVE" },
          })
        }
        d = addDays(d, 1)
      }
    }
    console.log(`✓ BULK leave requests: ${leaveRows.length} (${approvedForBalance.length} approved historical w/ balances + attendance, ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  }

  // ============ LOANS / ADVANCES / EXPENSES ============
  const loan1 = await db.loan.create({
    data: { vendorId: finix.id, employeeId: empIds["EMP-0014"], type: "PERSONAL", principal: 60000, interestRate: 0, installmentAmount: 5000, installments: 12, startDate: daysAgo(90), outstanding: 45000, paidAmount: 15000, status: "ACTIVE", purpose: "Home repair" },
  })
  for (let i = 1; i <= 12; i++) {
    const due = iso(new Date(new Date(daysAgo(90)).getTime() + i * 30 * 86400000))
    await db.loanInstallment.create({
      data: { vendorId: loan1.vendorId, loanId: loan1.id, no: i, dueDate: due, amount: 5000, paidAmount: i <= 3 ? 5000 : 0, paidAt: i <= 3 ? new Date() : null, status: i <= 3 ? "PAID" : "PENDING" },
    })
  }
  await db.employeeHistory.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0014"], eventType: "LOAN", title: "Loan approved ৳60,000", description: "12 installments", amount: 60000, effectiveDate: daysAgo(90) } })
  const loan2 = await db.loan.create({
    data: { vendorId: finix.id, employeeId: empIds["EMP-0018"], type: "MEDICAL", principal: 25000, interestRate: 0, installmentAmount: 2500, installments: 10, startDate: daysAgo(60), outstanding: 20000, paidAmount: 5000, status: "ACTIVE", purpose: "Father's treatment" },
  })
  for (let i = 1; i <= 10; i++) {
    const due = iso(new Date(new Date(daysAgo(60)).getTime() + i * 30 * 86400000))
    await db.loanInstallment.create({ data: { vendorId: loan2.vendorId, loanId: loan2.id, no: i, dueDate: due, amount: 2500, paidAmount: i <= 2 ? 2500 : 0, paidAt: i <= 2 ? new Date() : null, status: i <= 2 ? "PAID" : "PENDING" } })
  }
  await db.advance.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0015"], amount: 8000, reason: "Emergency medical", requestDate: daysAgo(40), installments: 4, deducted: 4000, outstanding: 4000, status: "RECOVERING" } })
  await db.advance.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0023"], amount: 5000, reason: "Advance for relocation", requestDate: daysAgo(10), installments: 2, deducted: 0, outstanding: 5000, status: "PENDING" } })

  // ============ GUARANTOR FALLBACK DEMO (2026-10-14, user request) ============
  // EMP-0020 (Mizanur Rahman) is ABSENT for the whole current month (long
  // unauthorized absence) while carrying:
  //   • an ACTIVE loan (48,000 / 12 × 4,000; installment #2 due THIS month)
  //     guaranteed by EMP-0021 (Anisur Rahman) — consented through ESS
  //   • a RECOVERING advance (6,000 / 3 × 2,000; recovery started) with the
  //     same HR-designated guarantor
  // The current-month run below is CALCULATED (not yet approved/paid): the
  // engine's guarantor post-pass moves BOTH deductions (4,000 + 2,000 =
  // 6,000) onto EMP-0021's payroll entry — capped at 25% of his net — so the
  // ACTUAL amounts are visible in Payroll (run entries → Guarantor column +
  // breakdown dialog) and Payroll → Loan & Advance Control (recovery plan +
  // per-guarantor exposure). The borrower's loan/advance ledgers recover at
  // FINAL approval (payRun), exactly like a normal month.
  {
    const borrowerId = empIds["EMP-0020"]
    const guarantorId = empIds["EMP-0021"]
    // month-safe date helper (dstr itself does NOT normalise month overflow)
    const mdate = (ymOffset: number, day: number) => {
      const d = new Date(YEAR, MONTH - 1 + ymOffset, day)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    }
    // -- loan: started two months back (day 5); #1 PAID last month, #2 due THIS month --
    const loanStart = mdate(-2, 5)
    const gLoan = await db.loan.create({
      data: {
        vendorId: finix.id, employeeId: borrowerId, type: "PERSONAL",
        principal: 48000, interestRate: 0, installmentAmount: 4000, installments: 12,
        startDate: loanStart, outstanding: 44000, paidAmount: 4000, status: "ACTIVE",
        purpose: "Family medical treatment (guarantor fallback demo)",
        guarantorId, guarantorStatus: "AGREED", guarantorRespondedAt: new Date(`${loanStart}T10:00:00Z`), guarantorNote: "Consented through My Self-Service → My Loans",
      },
    })
    for (let k = 1; k <= 12; k++) {
      await db.loanInstallment.create({
        data: { vendorId: gLoan.vendorId, loanId: gLoan.id, no: k, dueDate: mdate(-2 + k, 5), amount: 4000, paidAmount: k === 1 ? 4000 : 0, paidAt: k === 1 ? new Date(`${mdate(-1, 5)}T12:00:00Z`) : null, status: k === 1 ? "PAID" : "PENDING" },
      })
    }
    await db.employeeHistory.create({ data: { vendorId: finix.id, employeeId: borrowerId, eventType: "LOAN", title: "Loan approved ৳48,000", description: "12 installments · guarantor Anisur Rahman (agreed via ESS)", amount: 48000, effectiveDate: loanStart } })
    // -- advance: requested last month, recovery from this month; same guarantor (HR-designated → AGREED immediately) --
    await db.advance.create({
      data: {
        vendorId: finix.id, employeeId: borrowerId, amount: 6000,
        reason: "Emergency — prolonged illness (guarantor fallback demo)",
        requestDate: mdate(-1, 8), recoveryDate: mdate(0, 1), installments: 3,
        deducted: 0, outstanding: 6000, status: "RECOVERING",
        guarantorId, guarantorStatus: "AGREED",
      },
    })
    // -- the borrower is absent the WHOLE current month: overwrite every
    //    current-month attendance row to ABSENT (no times) so the payroll
    //    engine sees zero present+leave days → no payable salary → fallback --
    const monthPrefix = `${YEAR}-${String(MONTH).padStart(2, "0")}`
    const wiped = await db.attendance.updateMany({
      where: { vendorId: finix.id, employeeId: borrowerId, date: { startsWith: monthPrefix } },
      data: {
        status: "ABSENT", checkIn: null, checkOut: null,
        workingMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0,
        deviceInfo: null, remarks: "Long unauthorized absence (guarantor fallback demo)",
      },
    })
    console.log(`✓ guarantor fallback demo: loan ৳48,000 + advance ৳6,000 for absent EMP-0020, guarantor EMP-0021 (${wiped.count} current-month attendance rows wiped to ABSENT)`)
  }

  const expSeeds: [string, string, string, number, string, string][] = [
    ["EMP-0016", "CLIENT", "Client entertainment — Ramadan campaign", 3200, daysAgo(12), "REIMBURSED"],
    ["EMP-0017", "OFFICE", "Router and switch purchase", 8500, daysAgo(20), "REIMBURSED"],
    ["EMP-0008", "TRAVEL", "Inter-store stock audit travel", 1800, daysAgo(3), "PENDING"],
    ["EMP-0018", "TRANSPORT", "Delivery fuel reimbursement", 1200, daysAgo(2), "PENDING"],
    ["EMP-0022", "FOOD", "Team lunch after stock take", 2400, daysAgo(1), "PENDING"],
  ]
  for (const [code, cat, title, amount, date, status] of expSeeds) {
    await db.expenseClaim.create({
      data: { vendorId: finix.id, employeeId: empIds[code], category: cat, title, amount, date, status, approvedAmount: status === "REIMBURSED" ? amount : null, reimbursementDate: status === "REIMBURSED" ? new Date().toISOString().slice(0, 10) : null, approvedBy: status === "REIMBURSED" ? "seed" : null, paymentMethod: "BANK" },
    })
  }
  console.log("✓ loans, advances, expenses")

  // ---- BULK TEST CORPUS: loans (~4%), advances (~3%), expenses (~8%) ----
  if (bulkIds.length > 0) {
    const t0 = Date.now()
    const bulkCodes = Object.keys(bulkIdByCode)
    const nLoans = Math.max(1, Math.round(bulkIds.length * 0.04))
    const nAdv = Math.max(1, Math.round(bulkIds.length * 0.03))
    const nExp = Math.max(1, Math.round(bulkIds.length * 0.08))
    // loans with installment schedules (paid: first 2-4)
    let loanRows = 0, installmentRows = 0
    for (let i = 0; i < nLoans; i++) {
      const code = bulkCodes[(i * 7) % bulkCodes.length]
      const principal = ri(4, 24) * 5000
      const installments = ri(6, 12)
      const installmentAmount = Math.round(principal / installments / 500) * 500 || 500
      const paid = ri(2, 4)
      const startDate = daysAgo(ri(30, 150))
      const loan = await db.loan.create({
        data: {
          vendorId: finix.id, employeeId: bulkIdByCode[code], type: pick(["PERSONAL", "MEDICAL", "HOUSE"]),
          principal, interestRate: 0, installmentAmount, installments, startDate,
          outstanding: Math.max(0, principal - paid * installmentAmount), paidAmount: Math.min(principal, paid * installmentAmount),
          status: "ACTIVE", purpose: pick(["Home repair", "Family treatment", "Children's education", "Emergency"]),
        },
      })
      await db.loanInstallment.createMany({
        data: Array.from({ length: installments }, (_, k) => ({
          vendorId: loan.vendorId, loanId: loan.id, no: k + 1,
          dueDate: iso(new Date(new Date(startDate).getTime() + (k + 1) * 30 * 86400000)),
          amount: installmentAmount,
          paidAmount: k < paid ? installmentAmount : 0,
          paidAt: k < paid ? new Date() : null,
          status: k < paid ? "PAID" : "PENDING",
        })),
      })
      loanRows++; installmentRows += installments
    }
    // advances
    await db.advance.createMany({
      data: Array.from({ length: nAdv }, (_, i) => {
        const code = bulkCodes[(i * 11 + 3) % bulkCodes.length]
        const amount = ri(2, 10) * 1000
        const deducted = rnd() < 0.5 ? Math.round(amount / 2) : 0
        return {
          vendorId: finix.id, employeeId: bulkIdByCode[code], amount,
          reason: pick(["Emergency medical", "Salary advance", "Relocation", "Festival preparation"]),
          requestDate: daysAgo(ri(10, 80)), installments: ri(2, 6),
          deducted, outstanding: amount - deducted,
          status: deducted > 0 ? "RECOVERING" : "PENDING",
        }
      }),
    })
    // expense claims
    await db.expenseClaim.createMany({
      data: Array.from({ length: nExp }, (_, i) => {
        const code = bulkCodes[(i * 13 + 5) % bulkCodes.length]
        const status = rnd() < 0.45 ? "PENDING" : rnd() < 0.8 ? "REIMBURSED" : "REJECTED"
        const amount = ri(3, 60) * 250
        return {
          vendorId: finix.id, employeeId: bulkIdByCode[code],
          category: pick(["TRAVEL", "FOOD", "TRANSPORT", "OFFICE", "CLIENT"]),
          title: pick(["Client visit travel", "Field operation supplies", "Team coordination lunch", "Courier and postage", "Workshop materials"]),
          amount, date: daysAgo(ri(1, 45)), status,
          approvedAmount: status === "REIMBURSED" ? amount : null,
          reimbursementDate: status === "REIMBURSED" ? daysAgo(ri(0, 10)) : null,
          approvedBy: status === "REIMBURSED" ? "seed" : null,
          paymentMethod: "BANK",
        }
      }),
    })
    console.log(`✓ BULK loans/advances/expenses: ${loanRows} loans (+${installmentRows} installments), ${nAdv} advances, ${nExp} expense claims (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  }

  // ============ APPROVAL REQUESTS for seeded pending items ============
  // Pending demo items must sit in the approval workflow exactly like real
  // submissions — otherwise approvers open the queue/tables and see "no
  // approval option" for them. (The substitute-pending leave intentionally
  // stays out until the substitute accepts.)
  {
    const { submitForApproval } = await import("./approval")
    const seedCtx: any = { userId: "seed", userName: "Seeded Data", vendorId: finix.id, role: "HR_ADMIN", permissions: new Set<string>() }
    const ltRows = await db.leaveType.findMany({ where: { vendorId: finix.id } })
    const pendingLeaves = await db.leaveRequest.findMany({
      where: { vendorId: finix.id, status: "PENDING", OR: [{ substituteStatus: null }, { substituteStatus: { not: "PENDING" } }] },
    })
    for (const l of pendingLeaves) {
      const emp = await db.employee.findUnique({ where: { id: l.employeeId } })
      const tname = ltRows.find((t) => t.id === l.leaveTypeId)?.name || "Leave"
      const approvalId = await submitForApproval(seedCtx, "LEAVE", "LeaveRequest", l.id,
        `${emp?.fullName} — ${tname} (${l.days}d)`, { employeeId: l.employeeId, amount: l.days, leaveTypeId: l.leaveTypeId })
      await db.leaveRequest.update({ where: { id: l.id }, data: { approvalRequestId: approvalId } })
    }
    const pendingExpenses = await db.expenseClaim.findMany({ where: { vendorId: finix.id, status: "PENDING" } })
    for (const c of pendingExpenses) {
      const emp = await db.employee.findUnique({ where: { id: c.employeeId } })
      const approvalId = await submitForApproval(seedCtx, "EXPENSE", "ExpenseClaim", c.id,
        `${c.title} ৳${c.amount} — ${emp?.fullName}`, { employeeId: c.employeeId, amount: c.amount, claimId: c.id })
      await db.expenseClaim.update({ where: { id: c.id }, data: { approvalRequestId: approvalId } })
    }
    const pendingAdvances = await db.advance.findMany({ where: { vendorId: finix.id, status: "PENDING" } })
    for (const a of pendingAdvances) {
      const emp = await db.employee.findUnique({ where: { id: a.employeeId } })
      const approvalId = await submitForApproval(seedCtx, "ADVANCE", "Advance", a.id,
        `Advance ৳${a.amount} — ${emp?.fullName}`, { employeeId: a.employeeId, amount: a.amount, advanceId: a.id })
      await db.advance.update({ where: { id: a.id }, data: { approvalRequestId: approvalId } })
    }
    console.log(`✓ approval requests attached to seeded pending items (${pendingLeaves.length} leave, ${pendingExpenses.length} expense, ${pendingAdvances.length} advance)`)
  }

  // ============ R3-4/R3-5 WAVE DEMOS (leave money · loan arrears · recovery floor · field permissions) ============
  // One curated fixture per closed round-3 finding so QA can exercise each
  // remediation end-to-end straight from the seeded corpus — no hand-crafted
  // rows needed. Everything below rides the REAL engines (approval workflow,
  // loan-math, payroll calculateRun) exactly like live submissions would.
  {
    // ---- LVE-005/006/007 (R3-4) — leave encashment, both lifecycle states ----
    // PENDING: EMP-0007 requested 5 days of Earned Leave encashment — the
    // reservation (pending += 5) and the ENCASHMENT approval request are
    // created through the same code path leave.encash uses, so the queue
    // entry, the ESS "pending encashment" card and the Balances tab all see
    // it. Approving converts pending → used and queues the payout bonus.
    const { submitForApproval: submitEncash } = await import("./approval")
    const encashBal = await db.leaveBalance.findFirst({
      where: { employeeId: empIds["EMP-0007"], leaveTypeId: leaveTypes["EARNED"], year: YEAR },
    })
    if (encashBal) {
      const days = 5
      await db.leaveBalance.update({ where: { id: encashBal.id }, data: { pending: { increment: days } } })
      await submitEncash(seedCtx, "ENCASHMENT", "LeaveBalance", encashBal.id,
        `Leave encashment — ${days} day(s) of Earned Leave`,
        { employeeId: empIds["EMP-0007"], amount: days, leaveTypeId: leaveTypes["EARNED"], days, year: YEAR })
    }
    // APPROVED (historical): EMP-0002 encashed 4 days of Earned Leave last
    // month — balance already committed (used += 4) and the ENCASHMENT bonus
    // is APPROVED for the CURRENT period, so the CALCULATED run below picks
    // it up exactly like applyEncashmentDecision's queue would.
    const encashBal2 = await db.leaveBalance.findFirst({
      where: { employeeId: empIds["EMP-0002"], leaveTypeId: leaveTypes["EARNED"], year: YEAR },
    })
    if (encashBal2) await db.leaveBalance.update({ where: { id: encashBal2.id }, data: { used: { increment: 4 } } })
    const encashStruct = await db.salaryStructure.findFirst({ where: { employeeId: empIds["EMP-0002"], status: "ACTIVE" } })
    if (encashStruct) {
      // same money math as the finalize hook: round(dailyRate × rate) per day
      const daily = Math.round(dailyRate(encashStruct.gross) * 1)
      await db.bonus.create({
        data: {
          vendorId: finix.id, employeeId: empIds["EMP-0002"], type: "ENCASHMENT", calcType: "FIXED",
          amount: Math.round(daily * 4), periodMonth: MONTH, periodYear: YEAR,
          label: "Leave encashment — 4 day(s) Earned Leave (approved last month)",
          status: "APPROVED", approvedBy: "seed",
        },
      })
    }

    // ---- LOA-001/002 (R3-4) — loan in arrears with OVERDUE installments ----
    // EMP-0016: ৳24,000 over 6 installments started 150 days back — #1-2 PAID,
    // #3-4 past-due and unpaid (OVERDUE), the rest PENDING. The Loans page
    // shows the arrears chip, payroll's recovery engine picks up the 2 due
    // installments, and loanOverdueSweep keeps the rest honest on tick.
    const loan3 = await db.loan.create({
      data: { vendorId: finix.id, employeeId: empIds["EMP-0016"], type: "PERSONAL", principal: 24000, interestRate: 0, installmentAmount: 4000, installments: 6, startDate: daysAgo(150), outstanding: 16000, paidAmount: 8000, status: "ACTIVE", purpose: "Laptop purchase (arrears demo)" },
    })
    for (let i = 1; i <= 6; i++) {
      const due = iso(new Date(new Date(daysAgo(150)).getTime() + i * 30 * 86400000))
      await db.loanInstallment.create({
        data: { vendorId: loan3.vendorId, loanId: loan3.id, no: i, dueDate: due, amount: 4000, paidAmount: i <= 2 ? 4000 : 0, paidAt: i <= 2 ? new Date() : null, status: i <= 2 ? "PAID" : due < TODAY ? "OVERDUE" : "PENDING" },
      })
    }
    await db.employeeHistory.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0016"], eventType: "LOAN", title: "Loan approved ৳24,000", description: "6 installments — #3-4 now overdue (arrears demo)", amount: 24000, effectiveDate: daysAgo(150) } })

    // ---- ADV-001 (R3-4) — advance beyond the 50% recovery floor ----
    // EMP-0018 (gross ৳17,000) is recovering a ৳12,000 advance with ৳10,000
    // still outstanding — past the default recoveryMaxPctOfNet (50% of net),
    // so the current-month CALCULATED run defers it and the entry's
    // breakdownJson carries recoveryDeferred for the Payroll UI warning.
    await db.advance.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0018"], amount: 12000, reason: "Family medical emergency (recovery-floor demo)", requestDate: daysAgo(25), installments: 6, deducted: 2000, outstanding: 10000, status: "RECOVERING" } })

    // ---- FLD-103 (R3-5) — tenant field-level permission rules ----
    // Pre-populates Settings → Field Permissions so every access mode has a
    // live example (the engine combines these with route perms — restrictive
    // wins). HR_ADMIN / VENDOR_OWNER stay full (no role entry → tenant default).
    //   HR_MANAGER   salary=mask   → amounts hidden, structure section read-only
    //   DEPT_MANAGER salary=none   → no salary/bank surfaces at all
    //   EMPLOYEE     identity=mask → ESS sees masked NID numbers (no salary/bank)
    await db.hrSetting.create({
      data: { vendorId: finix.id, group: "fieldPermissions", key: "roles", value: JSON.stringify({
        HR_MANAGER: { salary: "mask" },
        DEPT_MANAGER: { salary: "none", bank: "none" },
        EMPLOYEE: { salary: "none", bank: "none", identity: "mask" },
      }) },
    })
    await db.hrSetting.create({
      data: { vendorId: finix.id, group: "fieldPermissions", key: "default", value: JSON.stringify({ contact: "full", employment: "full" }) },
    })

    // ---- WF-001 (R3-4) — aged pending approval for the reminder sweep ----
    // approvalReminderSweep (reminderDays default 3) reminds after 3 days and
    // escalates to the vendor owner after 2× — age the oldest pending leave
    // approval back 5 days so the first dailyJobs tick produces the digest.
    const agedApproval = await db.approvalRequest.findFirst({
      where: { vendorId: finix.id, processType: "LEAVE", status: "PENDING" },
      orderBy: { createdAt: "asc" },
    })
    if (agedApproval) {
      await db.approvalRequest.update({ where: { id: agedApproval.id }, data: { createdAt: new Date(Date.now() - 5 * 86400000) } })
    }
    console.log("✓ R3-4/R3-5 wave demos: pending encashment (EMP-0007) + approved encashment (EMP-0002), overdue loan (EMP-0016), recovery-floor advance (EMP-0018), unpaid leave (EMP-0013), field-permission rules, aged approval for reminder sweep")
  }

  // ============ BONUSES / DEDUCTIONS ============
  await db.bonus.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0009"], type: "SALES_COMMISSION", calcType: "PERCENT", amount: 12000, percent: 2, baseAmount: 600000, periodMonth: PREV_MONTH, periodYear: PREV_YEAR, label: "August sales commission (2% of ৳6,00,000)", status: "APPROVED", approvedBy: "seed" } })
  await db.bonus.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0010"], type: "SALES_COMMISSION", calcType: "PERCENT", amount: 9500, percent: 2, baseAmount: 475000, periodMonth: PREV_MONTH, periodYear: PREV_YEAR, label: "August sales commission", status: "APPROVED", approvedBy: "seed" } })
  await db.bonus.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0007"], type: "PERFORMANCE", calcType: "FIXED", amount: 15000, periodMonth: PREV_MONTH, periodYear: PREV_YEAR, label: "Q2 performance bonus", status: "APPROVED", approvedBy: "seed" } })
  await db.bonus.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0020"], type: "FESTIVAL", calcType: "FIXED", amount: 26000, periodMonth: MONTH, periodYear: YEAR, label: "Upcoming festival bonus", status: "PENDING" } })
  await db.deduction.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0015"], type: "OTHER", label: "Damaged goods recovery", amount: 1500, month: MONTH, year: YEAR, status: "ACTIVE" } })

  // ============ PERFORMANCE / KPI / TASKS ============
  const cycle = await db.reviewCycle.create({ data: { vendorId: finix.id, name: `${YEAR} Annual Performance Review`, year: YEAR, startDate: dstr(YEAR, 1, 1), endDate: dstr(YEAR, 12, 15), status: "ACTIVE" } })
  const kpiSales = await db.kpiTemplate.create({
    data: { vendorId: finix.id, name: "Sales Executive KPI", designationId: desigs["SE"], itemsJson: JSON.stringify([
      { name: "Sales Amount (৳)", target: 500000, unit: "৳", weight: 40 },
      { name: "Orders Completed", target: 120, unit: "orders", weight: 20 },
      { name: "Conversion Rate (%)", target: 25, unit: "%", weight: 20 },
      { name: "New Customers", target: 15, unit: "customers", weight: 20 },
    ]) },
  })
  const kpiCs = await db.kpiTemplate.create({
    data: { vendorId: finix.id, name: "Customer Service KPI", designationId: desigs["CSR"], itemsJson: JSON.stringify([
      { name: "Tickets Handled", target: 400, unit: "tickets", weight: 30 },
      { name: "Avg Response Time (min)", target: 15, unit: "min", weight: 25 },
      { name: "Resolution Rate (%)", target: 90, unit: "%", weight: 25 },
      { name: "Customer Rating (1-5)", target: 4.5, unit: "stars", weight: 20 },
    ]) },
  })
  const kpiWh = await db.kpiTemplate.create({
    data: { vendorId: finix.id, name: "Warehouse KPI", designationId: desigs["WK"], itemsJson: JSON.stringify([
      { name: "Orders Processed", target: 900, unit: "orders", weight: 30 },
      { name: "Picking Accuracy (%)", target: 99, unit: "%", weight: 25 },
      { name: "Packing Accuracy (%)", target: 99, unit: "%", weight: 25 },
      { name: "Avg Processing Time (min)", target: 20, unit: "min", weight: 20 },
    ]) },
  })
  const _kpiAcc = await db.kpiTemplate.create({
    data: { vendorId: finix.id, name: "Accounting KPI", designationId: desigs["AO"], itemsJson: JSON.stringify([
      { name: "Tasks Completed", target: 50, unit: "tasks", weight: 40 },
      { name: "Error Rate (%)", target: 2, unit: "%", weight: 30 },
      { name: "Reconciliation Completion (%)", target: 100, unit: "%", weight: 30 },
    ]) },
  })
  const kpiAssigns: [string, string, Record<string, number>][] = [
    ["EMP-0009", kpiSales.id, { "Sales Amount (৳)": 620000, "Orders Completed": 138, "Conversion Rate (%)": 27, "New Customers": 18 }],
    ["EMP-0010", kpiSales.id, { "Sales Amount (৳)": 455000, "Orders Completed": 105, "Conversion Rate (%)": 22, "New Customers": 11 }],
    ["EMP-0012", kpiCs.id, { "Tickets Handled": 430, "Avg Response Time (min)": 12, "Resolution Rate (%)": 93, "Customer Rating (1-5)": 4.6 }],
  ]
  for (const [code, tplId, actuals] of kpiAssigns) {
    const tpl = await db.kpiTemplate.findUnique({ where: { id: tplId } })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    const items = JSON.parse(tpl!.itemsJson)
    const results = items.map((i: any) => {
      const actual = actuals[i.name] ?? null
      const achievementPct = actual != null ? Math.round((actual / i.target) * 1000) / 10 : null
      const score = achievementPct != null ? Math.round((achievementPct * i.weight) / 100) : null
      return { ...i, actual, achievementPct, score }
    })
    const totalScore = results.reduce((s: number, r: any) => s + (r.score || 0), 0)
    const rating = totalScore >= 90 ? 5 : totalScore >= 75 ? 4 : totalScore >= 60 ? 3 : 2
    await db.kpiAssignment.create({
      data: { vendorId: finix.id, employeeId: empIds[code], templateId: tplId, periodLabel: `${YEAR}-Q2`, dueDate: daysAgo(15), status: "SUBMITTED", resultsJson: JSON.stringify(results.map((r: any) => ({ ...r, rating: r.score != null ? rating : null }))) },
    })
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
  await db.kpiAssignment.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0014"], templateId: kpiWh.id, periodLabel: `${YEAR}-Q3`, dueDate: daysAgo(-30), status: "PENDING", resultsJson: JSON.stringify(JSON.parse((await db.kpiTemplate.findUnique({ where: { id: kpiWh.id } }))!.itemsJson).map((i: any) => ({ ...i, actual: null, achievementPct: null, score: null }))) } })

  const reviewSeeds: [string, Record<string, number>, string, string][] = [
    ["EMP-0009", { attendance: 4, punctuality: 4, productivity: 5, quality: 4, teamwork: 4, communication: 4, customerService: 5, leadership: 3, targetAchievement: 5 }, "Excellent sales performance, exceeded targets two quarters in a row.", "Ready for Senior role consideration."],
    ["EMP-0012", { attendance: 5, punctuality: 5, productivity: 4, quality: 4, teamwork: 5, communication: 5, customerService: 5, leadership: 3, targetAchievement: 4 }, "Consistently reliable and customer-focused.", "—" ],
    ["EMP-0014", { attendance: 3, punctuality: 3, productivity: 4, quality: 4, teamwork: 3, communication: 3, customerService: 3, leadership: 2, targetAchievement: 4 }, "Meets warehouse targets; needs better communication.", "—" ],
  ]
  for (const [code, ratings, managerComments, goals] of reviewSeeds) {
    const values = Object.values(ratings)
    const overall = Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10
    await db.performanceReview.create({
      data: { vendorId: finix.id, cycleId: cycle.id, employeeId: empIds[code], reviewerId: empIds["EMP-0007"], ratingsJson: JSON.stringify(ratings), overallRating: overall, managerComments, strengths: "Team collaboration", weaknesses: "Documentation habits", goals, improvementPlan: "Monthly 1:1 check-ins", status: "FINAL", submittedAt: new Date() },
    })
  }

  const taskSeeds: [string, string, string, string, string, string, number][] = [
    ["EMP-0004", "Verify onboarding documents of new joiners", "HR", "HIGH", daysAgo(-5), "IN_PROGRESS", 60],
    ["EMP-0003", "Publish Q3 HR policy update", "HR", "MEDIUM", daysAgo(-10), "TODO", 0],
    ["EMP-0005", "Close monthly books", "PAYROLL", "URGENT", daysAgo(-2), "IN_PROGRESS", 80],
    ["EMP-0013", "Quarterly stock audit preparation", "DEPARTMENT", "HIGH", daysAgo(-7), "TODO", 10],
    ["EMP-0017", "Upgrade POS terminals at ST02", "DEPARTMENT", "MEDIUM", daysAgo(-14), "ON_HOLD", 30],
    ["EMP-0009", "Prepare Eid campaign sales plan", "EMPLOYEE", "HIGH", daysAgo(-3), "IN_PROGRESS", 40],
    ["EMP-0016", "Design festive social media creatives", "EMPLOYEE", "MEDIUM", daysAgo(-6), "TODO", 0],
    ["EMP-0008", "Weekly shelf planogram update", "EMPLOYEE", "LOW", daysAgo(-1), "TODO", 0],
  ]
  for (const [code, title, scope, priority, due, status, progress] of taskSeeds) {
    await db.task.create({
      data: { vendorId: finix.id, title, description: title + " — follow standard checklist.", assigneeId: empIds[code], scope, priority, startDate: daysAgo(2), dueDate: due, status, progress, checklistJson: JSON.stringify([{ text: "Gather requirements", done: true }, { text: "Execute", done: progress > 30 }, { text: "Report", done: progress >= 100 }]), commentsJson: "[]", createdBy: "seed" },
    })
  }
  // ---- BULK TEST CORPUS: KPI assignments (~5% of bulk workforce) ----
  if (bulkIds.length > 0) {
    const t0 = Date.now()
    const kpiTpls = [kpiSales, kpiCs, kpiWh].filter(Boolean)
    if (kpiTpls.length > 0) {
      const tplRows = await db.kpiTemplate.findMany({ where: { id: { in: kpiTpls.map((t) => t.id) } } })
      const bulkCodes = Object.keys(bulkIdByCode)
      const nKpi = Math.max(1, Math.round(bulkIds.length * 0.05))
      const kpiRows: any[] = []
      for (let i = 0; i < nKpi; i++) {
        const code = bulkCodes[(i * 17 + 7) % bulkCodes.length]
        const tpl = pick(tplRows)
        const items = JSON.parse(tpl.itemsJson)
        const results = items.map((it: any) => {
          const actual = Math.round(it.target * (0.6 + rnd() * 0.8))
          const achievementPct = Math.round((actual / it.target) * 1000) / 10
          const score = Math.round((achievementPct * it.weight) / 100)
          return { ...it, actual, achievementPct, score }
        })
        const totalScore = results.reduce((s: number, r: any) => s + (r.score || 0), 0)
        const rating = totalScore >= 90 ? 5 : totalScore >= 75 ? 4 : totalScore >= 60 ? 3 : 2
        kpiRows.push({
          vendorId: finix.id, employeeId: bulkIdByCode[code], templateId: tpl.id,
          periodLabel: `${YEAR}-Q${ri(1, 3)}`, dueDate: daysAgo(ri(5, 45)), status: pick(["SUBMITTED", "PENDING", "APPROVED"]),
          resultsJson: JSON.stringify(results.map((r: any) => ({ ...r, rating: r.score != null ? rating : null }))),
        })
      }
      await db.kpiAssignment.createMany({ data: kpiRows })
      console.log(`✓ BULK KPI assignments: ${kpiRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    }
  }
  console.log("✓ performance, KPI, tasks")

  // ============ PAYROLL — previous month PAID run through the real engine ============
  // The real engine runs for the CURATED cast only (proves end-to-end payslips +
  // journals + loan recovery); the huge bulk corpus gets direct historical runs
  // below — keeps the engine run fast while the DB still gets payroll volume.
  const run = await db.payrollRun.create({
    data: { vendorId: finix.id, periodMonth: PREV_MONTH, periodYear: PREV_YEAR, runType: "REGULAR", cutoffDate: dstr(PREV_YEAR, PREV_MONTH, 25), status: "DRAFT", createdBy: "seed" },
  })
  await calculateRun(seedCtx, run.id, undefined, bulkIds.length ? { excludeEmployeeIds: bulkIds } : undefined)
  const run2 = await db.payrollRun.findUnique({ where: { id: run.id } })
  // approve directly (seed) then pay through the engine → payslips + journals + loan recovery
  await db.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })
  await payRun(seedCtx, run.id)
  console.log(`✓ payroll: ${monthName(PREV_MONTH)} ${PREV_YEAR} PAID (net ৳${run2?.totalNet.toFixed(0)}) with payslips + journals`)

  // current-month run — CALCULATED through the real engine (2026-10-14): the
  // guarantor fallback demo above becomes visible end-to-end (entries carry
  // the ACTUAL deduction amounts; Loan & Advance Control shows the recovery
  // plan). Status stays CALCULATED — HR reviews, approves and pays from the
  // UI, which is exactly the flow the ledger recovery is designed for.
  {
    const runNow = await db.payrollRun.create({
      data: { vendorId: finix.id, periodMonth: MONTH, periodYear: YEAR, runType: "REGULAR", cutoffDate: TODAY, status: "DRAFT", createdBy: "seed" },
    })
    const calc = await calculateRun(seedCtx, runNow.id, undefined, bulkIds.length ? { excludeEmployeeIds: bulkIds } : undefined)
    const gTot = (calc?.guarantorRecovery?.loan || 0) + (calc?.guarantorRecovery?.advance || 0)
    console.log(`✓ payroll: ${monthName(MONTH)} ${YEAR} CALCULATED (${calc?.count ?? "?"} entries${gTot ? `, ৳${gTot.toLocaleString("en-IN")} guarantor recovery` : ""}) — approve & pay from the UI to post the ledgers`)
  }

  // ---- BULK TEST CORPUS: historical PAID payroll runs (direct, batched) ----
  // Full-workforce runs for the SEED_TEST_PAYROLL_HISTORY_MONTHS months before
  // the engine run — payslips, journals and totals computed to be internally
  // consistent (net = gross + OT − absence − loan deduction).
  if (PAYROLL_HISTORY_MONTHS > 0) {
    const t0 = Date.now()
    const activeAll = await db.employee.findMany({
      where: { vendorId: finix.id, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE"] } },
      select: { id: true, fullName: true },
    })
    const structs = await db.salaryStructure.findMany({
      where: { vendorId: finix.id, status: "ACTIVE" },
      orderBy: { effectiveFrom: "desc" },
      select: { employeeId: true, gross: true, basic: true, houseRent: true, medical: true },
    })
    const grossByEmp = new Map<string, number>()
    const compByEmp = new Map<string, { basic: number; houseRent: number; medical: number }>()
    for (const s of structs) {
      if (!grossByEmp.has(s.employeeId)) {
        grossByEmp.set(s.employeeId, s.gross)
        compByEmp.set(s.employeeId, { basic: s.basic, houseRent: s.houseRent, medical: s.medical })
      }
    }
    const activeLoans = await db.loan.findMany({ where: { vendorId: finix.id, status: "ACTIVE" }, select: { employeeId: true, installmentAmount: true } })
    const loanByEmp = new Map<string, number>()
    for (const l of activeLoans) loanByEmp.set(l.employeeId, l.installmentAmount)

    let entryTotal = 0
    let notificationRows: any[] = []
    for (let m = 2; m <= 1 + PAYROLL_HISTORY_MONTHS; m++) {
      // m=2 → the month BEFORE the engine run (engine = PREV_MONTH); m=3,4 …
      // walk further back. JS Date normalizes negative months across year ends.
      const pm = new Date(YEAR, MONTH - m - 1, 1)
      const pMonth = pm.getMonth() + 1
      const pYear = pm.getFullYear()
      // guard: never collide with the engine run's period (vendor+period+runType is unique)
      if (pYear === PREV_YEAR && pMonth === PREV_MONTH) continue
      const paymentDate = dstr(pYear, pMonth, Math.min(30, new Date(pYear, pMonth, 0).getDate()))
      const hist = await db.payrollRun.create({
        data: { vendorId: finix.id, periodMonth: pMonth, periodYear: pYear, runType: "REGULAR", cutoffDate: dstr(pYear, pMonth, 25), processedDate: dstr(pYear, pMonth, 26), paymentDate, status: "PAID", createdBy: "seed" },
      })
      const entries: any[] = []
      let tGross = 0, tNet = 0, tOt = 0, tLoan = 0, tAbs = 0
      let seq = 1
      for (const emp of activeAll) {
        const gross = grossByEmp.get(emp.id)
        if (gross == null) continue
        const absent = ri(0, 2)
        const absenceDeduction = Math.round((gross / 26) * absent)
        const otMinutes = ri(0, 4) * 30
        const otAmount = Math.round((gross / 26 / 8 / 60) * otMinutes)
        const loanDeduction = m === 2 ? (loanByEmp.get(emp.id) || 0) : 0
        const net = gross + otAmount - absenceDeduction - loanDeduction
        const comp = compByEmp.get(emp.id) || { basic: Math.round(gross * 0.5), houseRent: Math.round(gross * 0.2), medical: Math.round(gross * 0.08) }
        tGross += gross; tNet += net; tOt += otAmount; tLoan += loanDeduction; tAbs += absenceDeduction
        entries.push({
          vendorId: finix.id, runId: hist.id, employeeId: emp.id,
          presentDays: 26 - absent, absentDays: absent, otMinutes,
          gross, otAmount, absenceDeduction, loanDeduction, net,
          breakdownJson: JSON.stringify({
            components: [
              { name: "Basic", amount: comp.basic }, { name: "House Rent", amount: comp.houseRent },
              { name: "Medical", amount: comp.medical }, { name: "Other Allowances", amount: gross - comp.basic - comp.houseRent - comp.medical },
            ],
            note: "Bulk test corpus historical run",
          }),
          payslipNumber: `PS-${pYear}${String(pMonth).padStart(2, "0")}-${String(seq++).padStart(4, "0")}`,
          status: "INCLUDED",
        })
      }
      for (let i = 0; i < entries.length; i += 500) {
        await db.payrollEntry.createMany({ data: entries.slice(i, i + 500) })
      }
      entryTotal += entries.length
      // one accounting journal per run (salary disbursement)
      const journal = await db.accountJournal.create({
        data: {
          vendorId: finix.id, refType: "PAYROLL", refId: hist.id,
          idempotencyKey: `seed-bulk-payroll-${hist.id}`,
          date: paymentDate, memo: `Salary disbursement — ${monthName(pMonth)} ${pYear} (bulk test corpus)`,
          linesJson: JSON.stringify([
            { account: "5100", accountName: "Salaries Expense", debit: tGross, credit: 0 },
            { account: "2100", accountName: "Salaries Payable", debit: 0, credit: tNet },
            { account: "2200", accountName: "Employee Loans Recovered", debit: 0, credit: tLoan },
          ]),
          amount: tNet, status: "POSTED",
        },
      })
      await db.payrollRun.update({
        where: { id: hist.id },
        data: { totalGross: tGross, totalNet: tNet, totalOt: tOt, totalDeduction: tAbs + tLoan, employeeCount: entries.length, journalId: journal.id, payoutConfirmedAt: new Date(paymentDate) },
      })
      // payslip notifications for the most recent historical run
      if (m === 2) {
        notificationRows = entries.map((e) => ({
          vendorId: finix.id, userId: null, employeeId: e.employeeId,
          title: "Salary Processed",
          message: `Your salary for ${monthName(pMonth)} ${pYear} has been processed. Payslip ${e.payslipNumber} is available in your portal.`,
          type: "PAYROLL", link: "ess",
        }))
      }
    }
    if (notificationRows.length) {
      for (let i = 0; i < notificationRows.length; i += 500) {
        await db.notification.createMany({ data: notificationRows.slice(i, i + 500) })
      }
    }
    console.log(`✓ BULK payroll history: ${PAYROLL_HISTORY_MONTHS} PAID runs / ${entryTotal.toLocaleString()} entries + payslips + journals + ${notificationRows.length.toLocaleString()} notifications (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  }

  // ============ LETTERS ============
  const { renderTemplate } = await import("./seed-helpers")
  const appointmentTpl = await db.letterTemplate.findFirst({ where: { vendorId: finix.id, type: "APPOINTMENT" } })
  if (appointmentTpl) {
    const vars = { employee_name: "Jahangir Alam", employee_id: "EMP-0011", designation: "Customer Service Rep.", department: "Customer Service", branch: "Textworks — Dhanmondi Plant", joining_date: dstr(2024, 3, 12), employment_type: "probationary", probation_months: "6", gross_salary: "19,000", basic_salary: "9,500", manager_name: "Mitu Chowdhury", company_name: "Bengal Textworks Ltd.", effective_date: dstr(2024, 3, 12), date: TODAY, employee_code: "EMP-0011", address: "Dhaka" }
    await db.hrLetter.create({
      data: { vendorId: finix.id, employeeId: empIds["EMP-0011"], type: "APPOINTMENT", templateId: appointmentTpl.id, letterNumber: `L-${YEAR}-0001`, subject: appointmentTpl.subject, content: renderTemplate(appointmentTpl.body, vars), signatoryName: "Nazmul Hasan", status: "ISSUED", issuedAt: new Date(), deliveryMethod: "PORTAL", createdBy: "seed" },
    })
  }
  const incrementTpl = await db.letterTemplate.findFirst({ where: { vendorId: finix.id, type: "INCREMENT" } })
  if (incrementTpl) {
    const vars = { employee_name: "Mizanur Rahman", employee_id: "EMP-0020", designation: "Sales Executive", department: "Sales", branch: "Textworks — Dhanmondi Plant", joining_date: dstr(2021, 12, 1), gross_salary: "28,000", basic_salary: "14,000", effective_date: daysAgo(30), company_name: "Bengal Textworks Ltd.", date: TODAY, manager_name: "Mahbubur Rahman" }
    await db.hrLetter.create({
      data: { vendorId: finix.id, employeeId: empIds["EMP-0020"], type: "INCREMENT", templateId: incrementTpl.id, letterNumber: `L-${YEAR}-0002`, subject: incrementTpl.subject, content: renderTemplate(incrementTpl.body, vars), signatoryName: "Nazmul Hasan", status: "ISSUED", issuedAt: new Date(), deliveryMethod: "EMAIL", emailStatus: "SENT", createdBy: "seed" },
    })
    // matching salary revision history
    await db.salaryRevision.create({
      data: { vendorId: finix.id, employeeId: empIds["EMP-0020"], previousSalary: 26000, newSalary: 28000, increaseAmount: 2000, increasePercent: 7.7, effectiveDate: daysAgo(30), reason: "Annual increment", type: "INCREMENT", status: "APPROVED", approvedBy: "seed" },
    })
    await db.employeeHistory.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0020"], eventType: "SALARY_REVISION", title: "Salary: ৳26,000 → ৳28,000 (+7.7%)", effectiveDate: daysAgo(30), amount: 28000 } })
  }
  console.log("✓ HR letters issued (appointment, increment)")

  // ============ RESIGNATION ============
  const res = await db.resignation.create({
    data: { vendorId: finix.id, employeeId: empIds["EMP-0015"], submissionDate: daysAgo(20), resignationDate: daysAgo(20), proposedLwd: daysAgo(-10), reason: "Moving to Chattogram for family reasons.", remarks: "Willing to help train replacement.", status: "NOTICE_PERIOD", acceptedAt: new Date(daysAgo(15)), actualLwd: daysAgo(-10), noticeMode: "FULL", noticeDays: 30, servedDays: 40 },
  })
  await db.employee.update({ where: { id: empIds["EMP-0015"] }, data: { status: "ON_LEAVE" } })
  const checklist = [
    { department: "HR", items: [{ item: "Company assets returned", cleared: true }, { item: "ID card returned", cleared: true }, { item: "Documents returned", cleared: true }] },
    { department: "Finance", items: [{ item: "Loan settled", cleared: false }, { item: "Expenses settled", cleared: true }] },
    { department: "IT", items: [{ item: "System access revoked", cleared: false }, { item: "Laptop returned", cleared: true }] },
    { department: "Admin", items: [{ item: "ID card returned", cleared: true }] },
    { department: "Warehouse", items: [{ item: "Company assets returned", cleared: true }] },
    { department: "Management", items: [{ item: "Final payroll processed", cleared: false }] },
  ]
  await db.exitClearance.create({ data: { vendorId: finix.id, resignationId: res.id, checklistJson: JSON.stringify(checklist), status: "IN_PROGRESS" } })
  await db.employeeHistory.create({ data: { vendorId: finix.id, employeeId: empIds["EMP-0015"], eventType: "RESIGNATION", title: "Resignation accepted — notice period started", effectiveDate: daysAgo(20) } })
  console.log("✓ resignation in notice period + exit clearance")

  // ============ ANNOUNCEMENTS / EVENTS / NOTIFICATIONS ============
  await db.announcement.create({ data: { vendorId: finix.id, title: "Eid Shopping Festival — Staff Bonus Schedule", body: "Dear team, the Eid shopping festival begins next week. Festival bonuses will be disbursed with this month's salary. Store teams please coordinate shift coverage with your managers.", audienceType: "ALL", audienceIds: "[]", pinned: true, publishedAt: new Date(), createdBy: "seed" } })
  await db.announcement.create({ data: { vendorId: finix.id, title: "Fire Drill — Head Office", body: "A mandatory fire drill will be held at the Head Office on Friday at 11:00 AM. All HO staff must participate.", audienceType: "BRANCH", audienceIds: JSON.stringify([branches["HO"]]), publishedAt: new Date(), createdBy: "seed" } })
  await db.companyEvent.create({ data: { vendorId: finix.id, title: "Monthly All-Hands Meeting", type: "MEETING", date: daysAgo(-2), time: "16:00", description: "Monthly business review", branchId: branches["HO"] } })
  await db.companyEvent.create({ data: { vendorId: finix.id, title: "Team Iftar Dinner", type: "EVENT", date: daysAgo(-5), time: "19:00", description: "All store teams invited" } })
  await db.companyEvent.create({ data: { vendorId: finix.id, title: "Payroll cutoff reminder", type: "PAYROLL_TASK", date: dstr(YEAR, MONTH, 25) } })

  await db.notification.create({ data: { vendorId: finix.id, userId: null, employeeId: empIds["EMP-0009"], title: "Salary Processed", message: `Your salary for ${monthName(PREV_MONTH)} ${PREV_YEAR} has been processed. Payslip is available in your portal.`, type: "PAYROLL", link: "ess" } })
  await db.notification.create({ data: { vendorId: finix.id, userId: null, employeeId: empIds["EMP-0012"], title: "Leave Approved", message: "Your casual leave request is approved.", type: "LEAVE", link: "ess" } })
  await db.notification.create({ data: { vendorId: finix.id, userId: null, employeeId: empIds["EMP-0012"], title: "Substitute Assignment", message: "You are proposed as substitute for Jahangir Alam's leave. Please accept/decline.", type: "LEAVE", link: "ess" } })

  // ================= NEW MODULES (AIT / procurement / inventory) =================
  // Approval workflows for the goods requisition + purchase flows
  const goodsWfDefs: { vendorId: string; type: string; name: string; steps: { name: string; role: string }[] }[] = [
    { vendorId: finix.id, type: "GOODS_REQUISITION", name: "Goods Requisition Approval", steps: [
      { name: "Department Head", role: "DEPT_MANAGER" }, { name: "HR Review", role: "HR_MANAGER" }, { name: "Final Approval", role: "HR_ADMIN" },
    ] },
    { vendorId: finix.id, type: "PURCHASE", name: "Purchase Approval", steps: [
      { name: "HR Review", role: "HR_MANAGER" }, { name: "Owner Approval", role: "VENDOR_OWNER" },
    ] },
    { vendorId: rongin.id, type: "GOODS_REQUISITION", name: "Goods Requisition workflow", steps: [{ name: "Owner Approval", role: "VENDOR_OWNER" }] },
    { vendorId: rongin.id, type: "PURCHASE", name: "Purchase workflow", steps: [{ name: "Owner Approval", role: "VENDOR_OWNER" }] },
  ]
  for (const def of goodsWfDefs) {
    const wf = await db.approvalWorkflow.create({ data: { vendorId: def.vendorId, name: def.name, processType: def.type, active: true } })
    for (const [i, s] of def.steps.entries()) {
      await db.approvalStep.create({ data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: i + 1, name: s.name, approverRole: s.role, required: true } })
    }
  }

  // Inventory demo — warehouses, suppliers, catalogue items + posted opening stock
  const main = await db.warehouse.create({ data: { vendorId: finix.id, name: "Head Office Store", branchId: branches["HO"], active: true } })
  await db.warehouse.create({ data: { vendorId: finix.id, name: "Dhanmondi Store Room", branchId: branches["ST01"], active: true } })
  await db.warehouse.create({ data: { vendorId: finix.id, name: "Uttara Store Room", branchId: branches["ST02"], active: true } })
  for (const s of [
    { name: "Smart Tech BD", contactPerson: "Rafiq Islam", mobile: "01711-223344", email: "sales@smarttechbd.com", address: "BDBL Bhaban, Kawran Bazar, Dhaka", tin: "123456789012" },
    { name: "Office Furnish Ltd.", contactPerson: "Shahana Begum", mobile: "01822-334455", email: "info@officefurnish.com", address: "Mirpur 10, Dhaka", tin: "234567890123" },
    { name: "Stationery World", contactPerson: "Kamal Uddin", mobile: "01933-445566", email: "order@stationeryworld.com.bd", address: "Nawabpur Road, Dhaka", tin: "345678901234" },
  ]) await db.supplier.create({ data: { vendorId: finix.id, ...s, active: true } })
  const itemDefs = [
    { code: "ITM-0001", name: "Wireless Mouse", category: "IT", unit: "Pcs", reorderLevel: 10, lastCost: 850, qty: 25 },
    { code: "ITM-0002", name: "Mechanical Keyboard", category: "IT", unit: "Pcs", reorderLevel: 5, lastCost: 2400, qty: 10 },
    { code: "ITM-0003", name: "27\" LED Monitor", category: "IT", unit: "Pcs", reorderLevel: 4, lastCost: 18500, qty: 6 },
    { code: "ITM-0004", name: "Laptop Core i5", category: "IT", unit: "Pcs", reorderLevel: 2, lastCost: 78000, qty: 2 },
    { code: "FUR-0001", name: "Ergonomic Office Chair", category: "FURNITURE", unit: "Pcs", reorderLevel: 3, lastCost: 12500, qty: 8 },
    { code: "FUR-0002", name: "Executive Desk", category: "FURNITURE", unit: "Pcs", reorderLevel: 2, lastCost: 22000, qty: 3 },
    { code: "STA-0001", name: "A4 Paper Ream", category: "STATIONERY", unit: "Ream", reorderLevel: 20, lastCost: 480, qty: 45 },
    { code: "STA-0002", name: "Ballpoint Pen (Box-12)", category: "STATIONERY", unit: "Box", reorderLevel: 15, lastCost: 320, qty: 30 },
    { code: "ELE-0001", name: "LED Tube Light 20W", category: "ELECTRICAL", unit: "Pcs", reorderLevel: 10, lastCost: 390, qty: 18 },
  ]
  const openingEntry = await db.stockEntry.create({
    data: {
      vendorId: finix.id, code: `SE-${YEAR}-00001`, warehouseId: main.id, invoiceNo: "OPENING",
      entryDate: dstr(YEAR, MONTH, 1), remarks: "Opening stock (seed)", status: "POSTED", postedAt: new Date(),
      byUserId: null, byUserName: "Seed",
      items: { create: itemDefs.map((it) => ({ vendorId: finix.id, itemId: "", itemName: it.name, quantity: it.qty, unitCost: it.lastCost })) },
    },
  })
  for (const it of itemDefs) {
    const rec = await db.item.create({ data: { vendorId: finix.id, code: it.code, name: it.name, category: it.category, unit: it.unit, reorderLevel: it.reorderLevel, lastCost: it.lastCost, active: true } })
    await db.stockEntryItem.updateMany({ where: { entryId: openingEntry.id, itemName: it.name }, data: { itemId: rec.id } })
    await db.stockLevel.create({ data: { vendorId: finix.id, itemId: rec.id, warehouseId: main.id, quantity: it.qty, reserved: 0 } })
    await db.stockTransaction.create({
      data: { vendorId: finix.id, itemId: rec.id, warehouseId: main.id, kind: "ENTRY", quantity: it.qty, balanceAfter: it.qty, unitCost: it.lastCost, refType: "STOCK_ENTRY", refId: openingEntry.id, note: "Opening stock (seed)", byUserName: "Seed" },
    })
  }

  // keep the stock-entry code sequence ahead of the opening entry
  await db.sequenceCounter.upsert({
    where: { key: `${finix.id}:stock-entry` },
    create: { key: `${finix.id}:stock-entry`, value: 1 },
    update: { value: { increment: 1 } },
  })

  // AIT fiscal-year bootstraps (r8 legal audit, 2026-10-14) — BOTH verified
  // years ship as versioned rule configs and the one containing today is
  // ACTIVE (Oct 2026 → FY 2026-27, Finance Act 2026; FY 2025-26 per the
  // enacted Finance Ordinance 2025 stays available for history/comparison).
  // Every figure remains admin-editable in AIT → Fiscal Year Config.
  const { defaultFy2026Config, defaultFy2027Config, currentIncomeYear } = await import("./ait-engine")
  const activeIncomeYear = currentIncomeYear(new Date())
  for (const def of [defaultFy2026Config(finix.id), defaultFy2027Config(finix.id)]) {
    const existing = await db.aitFiscalYear.findFirst({ where: { vendorId: finix.id, incomeYear: def.incomeYear } })
    if (existing) {
      // idempotent reseed — refresh the legally verified numbers in place
      await db.aitFiscalYear.update({
        where: { id: existing.id },
        data: {
          label: def.label, assessmentYear: def.assessmentYear, tdsSectionRef: def.tdsSectionRef,
          exemptionFraction: def.exemptionFraction, exemptionCap: def.exemptionCap,
          minimumTax: def.minimumTax, newTaxpayerMinimumTax: def.newTaxpayerMinimumTax,
          rebateRatePercent: def.rebateRatePercent, rebateIncomeCapPercent: def.rebateIncomeCapPercent,
          rebateCapFraction: def.rebateCapFraction, rebateCapAmount: def.rebateCapAmount,
          festivalBonusCount: def.festivalBonusCount, notes: def.notes,
        },
      })
      await db.aitTaxpayerCategory.deleteMany({ where: { fiscalYearId: existing.id } })
      await db.aitTaxSlab.deleteMany({ where: { fiscalYearId: existing.id } })
      await db.aitTaxpayerCategory.createMany({ data: def.categories.map((c) => ({ ...c, vendorId: finix.id, fiscalYearId: existing.id })) })
      await db.aitTaxSlab.createMany({ data: def.slabs.map((s) => ({ ...s, vendorId: finix.id, fiscalYearId: existing.id })) })
      if (def.incomeYear === activeIncomeYear) {
        await db.aitFiscalYear.updateMany({ where: { vendorId: finix.id }, data: { active: false } })
        await db.aitFiscalYear.update({ where: { id: existing.id }, data: { active: true } })
      }
      continue
    }
    const fy = await db.aitFiscalYear.create({
      data: {
        vendorId: finix.id, label: def.label, incomeYear: def.incomeYear, assessmentYear: def.assessmentYear,
        tdsSectionRef: def.tdsSectionRef, exemptionFraction: def.exemptionFraction, exemptionCap: def.exemptionCap,
        minimumTax: def.minimumTax, newTaxpayerMinimumTax: def.newTaxpayerMinimumTax,
        rebateRatePercent: def.rebateRatePercent, rebateIncomeCapPercent: def.rebateIncomeCapPercent,
        rebateCapFraction: def.rebateCapFraction, rebateCapAmount: def.rebateCapAmount,
        festivalBonusCount: def.festivalBonusCount,
        active: def.incomeYear === activeIncomeYear, notes: def.notes,
      },
    })
    await db.aitTaxpayerCategory.createMany({ data: def.categories.map((c) => ({ ...c, vendorId: finix.id, fiscalYearId: fy.id })) })
    await db.aitTaxSlab.createMany({ data: def.slabs.map((s) => ({ ...s, vendorId: finix.id, fiscalYearId: fy.id })) })
  }

  // ============ R3/R7 (2026-10-12) + R8 (2026-10-14) — LIVE TRACKING + FIELD FORCE dummy data ============
  // Clearly-identified TEST data (deviceId "SEED-DEMO"): live tracking states
  // with varied statuses for the map/filters and a complete 7-day field-force
  // corpus (visit locations, plans with items, completed / missed / ad-hoc
  // visits) so the planning board, history, reports, ESS My Visits AND the
  // Location Hit Map all have data.
  //
  // R8 (2026-10-14) — the old demo generated straight-line trails that could
  // not demonstrate the Location Hit Map (no dwells at the visit locations, no
  // unplanned stoppages). Each demo day is now a ROUTED itinerary:
  //   home → planned stop A (dwell + COMPLETED visit) → unplanned stop
  //   (tea-stall dwell 20-40 min → amber "S" pin) → planned stop B (dwell +
  //   visit) → home, with GPS pings every ~3 min while moving and ~4 min while
  //   stationary (±30 m wobble, inside the 75 m stoppage-detection anchor).
  // Only touches the TEST seed (never the production owner seed).
  {
    // ---- visit locations (master data) ------------------------------------
    const visitLocations = [
      { name: "Jamuna Future Park Outlet", address: "Block C, Prabartankur, Kuril, Dhaka 1229", lat: 23.8103, lng: 90.4125, radiusM: 200, contactName: "Shahriar Karim", contactPhone: "01711223344" },
      { name: "Bashundhara City Branch", address: "Level 7, Panthapath, Dhaka 1215", lat: 23.7508, lng: 90.3926, radiusM: 150, contactName: "Rumana Haque", contactPhone: "01755667788" },
      { name: "Uttara Showroom", address: "Sector 7, Uttara, Dhaka 1230", lat: 23.8701, lng: 90.3998, radiusM: 150, contactName: "Mahmudul Hasan", contactPhone: "01822334455" },
      { name: "Narayanganj Depot", address: "Khanpur, Narayanganj 1400", lat: 23.6155, lng: 90.4995, radiusM: 300, contactName: "Jahangir Alam", contactPhone: "01933445566" },
    ]
    const locIds: Record<string, string> = {}
    for (const l of visitLocations) {
      const rec = await db.visitLocation.findFirst({ where: { vendorId: finix.id, name: l.name } })
      const saved = rec
        ? await db.visitLocation.update({ where: { id: rec.id }, data: { ...l, active: true } })
        : await db.visitLocation.create({ data: { vendorId: finix.id, ...l, active: true } })
      locIds[l.name] = saved.id
    }

    // ---- routed-day generator helpers --------------------------------------
    type Pt = [number, number]
    const homes: Record<string, Pt> = {
      "EMP-0007": [23.8662, 90.3996], // Uttara Sector 10
      "EMP-0008": [23.7446, 90.3854], // Dhanmondi 15
      "EMP-0009": [23.8361, 90.3667], // Mirpur DOHS
      "EMP-0010": [23.7289, 90.3937], // Jigatola
    }
    // unplanned stoppage spots (tea stall / road-side pause) between the stops
    const teaStops: Record<string, Pt> = {
      "EMP-0007": [23.8432, 90.4090], // Banani corner tea stall
      "EMP-0008": [23.6878, 90.4561], // Demara road tea stall
    }
    const capNowMs = NOW.getTime() - 60_000 // today's trail never runs into the future
    const wall = (dayIso: string, minOfDay: number) => new Date(`${dayIso}T${toHHMM(minOfDay)}:00+06:00`)
    const points: any[] = []
    const emitted = new Set<string>() // (code, day, minute) — no duplicate clientEventIds

    const ffPoint = (code: string, dayIso: string, minOfDay: number, lat: number, lng: number, speedKmh: number) => {
      const key = `${code}|${dayIso}|${minOfDay}`
      if (emitted.has(key)) return
      emitted.add(key)
      const ts = wall(dayIso, minOfDay)
      if (ts.getTime() > capNowMs) return // seeded live: stop at "now"
      points.push({
        vendorId: finix.id, employeeId: empIds[code],
        timestamp: ts, clientTimestamp: ts.toISOString(),
        latitude: Number(lat.toFixed(6)), longitude: Number(lng.toFixed(6)),
        accuracyM: ri(6, 25), speed: speedKmh, heading: ri(0, 359),
        batteryPercentage: Math.max(5, 92 - Math.floor(minOfDay / 16)), isCharging: false,
        gpsStatus: "ON", networkStatus: rnd() < 0.25 ? "5G" : "4G",
        locationIntegrityStatus: "VERIFIED",
        clientEventId: `seed-ff-${code}-${dayIso}-${minOfDay}`,
        deviceId: "SEED-DEMO",
      })
    }

    /** moving leg: pings every ~3 min along the beeline with street-level wobble */
    const pushMoving = (code: string, dayIso: string, from: Pt, to: Pt, fromMin: number, toMin: number) => {
      const span = toMin - fromMin
      const n = Math.max(1, Math.round(span / 3))
      const dLat = to[0] - from[0], dLng = to[1] - from[1]
      const len = Math.hypot(dLat, dLng) || 1
      for (let i = 0; i <= n; i++) {
        const f = n === 0 ? 1 : i / n
        const wob = Math.sin(f * Math.PI) * (rnd() - 0.5) * 0.003 // ≤ ~±165 m off the beeline, 0 at endpoints
        ffPoint(code, dayIso, Math.round(fromMin + f * span),
          from[0] + dLat * f + (-dLng / len) * wob,
          from[1] + dLng * f + (dLat / len) * wob,
          ri(8, 35))
      }
    }

    /** stationary leg: pings every ~4 min, ±0.00027° (~30 m) wobble around the
     *  spot — inside the 75 m stoppage anchor so the cluster is detected */
    const pushDwell = (code: string, dayIso: string, at: Pt, fromMin: number, toMin: number) => {
      const n = Math.max(1, Math.round((toMin - fromMin) / 4))
      for (let i = 0; i <= n; i++) {
        const f = n === 0 ? 0 : i / n
        ffPoint(code, dayIso, Math.round(fromMin + f * (toMin - fromMin)),
          at[0] + (rnd() - 0.5) * 0.00054,
          at[1] + (rnd() - 0.5) * 0.00054,
          0)
      }
    }

    /** one full routed field day with its plan, stops and visits */
    const seedFieldDay = async (code: string, dayIso: string, plan: {
      a: string; b: string // visit-location names
      departHome: number; aArrive: number; aDepart: number // minutes of day (+06 wall clock)
      teaArrive: number; teaDepart: number
      bArrive: number; bDepart: number
      tasksA: string; tasksB: string
      adHoc?: { at: Pt; arrive: number; depart: number } // extra unplanned dwell (today's ad-hoc visit spot)
    }) => {
      const empId = empIds[code]
      if (!empId) return
      const A = visitLocations.find((l) => l.name === plan.a) ?? visitLocations[0]
      const B = visitLocations.find((l) => l.name === plan.b) ?? visitLocations[0]
      const home = homes[code] ?? [23.8103, 90.4125]
      const tea = teaStops[code] ?? [23.8103, 90.4125]
      const aC: Pt = [A.lat, A.lng], bC: Pt = [B.lat, B.lng]

      // ---- plan + items + completed visits --------------------------------
      const dayPlan = await db.visitPlan.findFirst({ where: { vendorId: finix.id, employeeId: empId, date: dayIso } })
        .then((p) => p ?? db.visitPlan.create({ data: { vendorId: finix.id, employeeId: empId, date: dayIso } }))
      const mkItem = async (locName: string, fromMin: number, toMin: number, tasks: string) => {
        const locId = locIds[locName]
        const existing = await db.visitPlanItem.findFirst({ where: { planId: dayPlan.id, locationId: locId } })
        return existing
          ? await db.visitPlanItem.update({ where: { id: existing.id }, data: { plannedFrom: toHHMM(fromMin), plannedTo: toHHMM(toMin), tasks } })
          : await db.visitPlanItem.create({ data: { vendorId: finix.id, planId: dayPlan.id, locationId: locId, plannedFrom: toHHMM(fromMin), plannedTo: toHHMM(toMin), tasks } })
      }
      const itemA = await mkItem(plan.a, plan.aArrive - 10, plan.aDepart + 15, plan.tasksA)
      const itemB = await mkItem(plan.b, plan.bArrive - 10, plan.bDepart + 15, plan.tasksB)
      // completed visit pinned to the check-in coordinates at the stop
      const mkVisit = async (itemId: string, locName: string, inMin: number, outMin: number, remarks: string) => {
        const L = visitLocations.find((l) => l.name === locName) ?? visitLocations[0]
        const existing = await db.visit.findFirst({ where: { planItemId: itemId } })
        if (existing) return existing
        return await db.visit.create({
          data: {
            vendorId: finix.id, employeeId: empId, planItemId: itemId, locationId: locIds[locName],
            checkInAt: wall(dayIso, inMin),
            checkInLat: Number((L.lat + (rnd() - 0.5) * 0.0004).toFixed(6)),
            checkInLng: Number((L.lng + (rnd() - 0.5) * 0.0004).toFixed(6)),
            checkInAccuracy: ri(6, 18),
            checkOutAt: wall(dayIso, outMin),
            checkOutLat: Number((L.lat + (rnd() - 0.5) * 0.0004).toFixed(6)),
            checkOutLng: Number((L.lng + (rnd() - 0.5) * 0.0004).toFixed(6)),
            durationMin: outMin - inMin, status: "COMPLETED", remarks,
          },
        })
      }
      await mkVisit(itemA.id, plan.a, plan.aArrive + 4, plan.aDepart - 5, "SEED-DEMO: on-window check-in; tasks completed.")
      await mkVisit(itemB.id, plan.b, plan.bArrive + 4, plan.bDepart - 5, "SEED-DEMO: on-window check-in; tasks completed.")

      // ---- the routed GPS trail -------------------------------------------
      pushMoving(code, dayIso, home, aC, plan.departHome, plan.aArrive)
      pushDwell(code, dayIso, aC, plan.aArrive, plan.aDepart)
      if (plan.adHoc) {
        pushMoving(code, dayIso, aC, plan.adHoc.at, plan.aDepart, plan.adHoc.arrive)
        pushDwell(code, dayIso, plan.adHoc.at, plan.adHoc.arrive, plan.adHoc.depart)
        pushMoving(code, dayIso, plan.adHoc.at, tea, plan.adHoc.depart, plan.teaArrive)
      } else {
        pushMoving(code, dayIso, aC, tea, plan.aDepart, plan.teaArrive)
      }
      pushDwell(code, dayIso, tea, plan.teaArrive, plan.teaDepart)
      pushMoving(code, dayIso, tea, bC, plan.teaDepart, plan.bArrive)
      pushDwell(code, dayIso, bC, plan.bArrive, plan.bDepart)
      pushMoving(code, dayIso, bC, home, plan.bDepart, plan.bDepart + Math.round(haversineKm(bC, home) * 2.2) + 15)
    }

    // rough great-circle km (travel-time filler for the leg home)
    const haversineKm = (a: Pt, b: Pt) => {
      const R = 6371, dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLng / 2) ** 2
      return 2 * R * Math.asin(Math.sqrt(s))
    }

    /** wandering day (GPS only, no visits) — leg times scale with distance so
     *  consecutive pings stay ≥ ~170 m apart (never close enough to cluster
     *  into phantom 3-minute stoppages); random pauses at the waypoints become
     *  the unplanned amber "S" stops. The route runs out and back. */
    const seedWanderDay = (code: string, dayIso: string, waypoints: Pt[], startMin: number) => {
      const home = homes[code] ?? [23.8103, 90.4125]
      const route: Pt[] = [home, ...waypoints, ...[...waypoints].reverse(), home]
      let cur: Pt = route[0], t = startMin
      for (let i = 1; i < route.length; i++) {
        const wp = route[i]
        const legMin = Math.max(4, Math.round(haversineKm(cur, wp) * 3.2) + ri(2, 6))
        pushMoving(code, dayIso, cur, wp, t, t + legMin)
        t += legMin
        if (i < route.length - 1 && rnd() < 0.65) {
          const pause = ri(15, 40) // roadside pause → detectable unplanned stop
          pushDwell(code, dayIso, wp, t, t + pause)
          t += pause
        } else {
          t += ri(6, 18) // brief traffic gap between pings
        }
        cur = wp
      }
    }

    // wipe the previous SEED-DEMO tracking corpus for the demo window so
    // re-seeding stays deterministic (old straight-line R3/R7 trails included)
    const firstDay = iso(new Date(NOW.getTime() - 6 * 86_400_000))
    await db.trackingPoint.deleteMany({
      where: {
        vendorId: finix.id, deviceId: "SEED-DEMO",
        timestamp: { gte: wall(firstDay, 0), lt: wall(addDays(TODAY, 1), 0) },
      },
    })

    // ---- the last 7 days: two routed field days each for EMP-0007/0008 ----
    const dayTasks = [
      ["Monthly stock audit + display check", "Sales pitch, new winter collection"],
      ["Collect payment + ledger reconcile", "Shelf audit and reorder list"],
      ["Compliance visit + photo proof", "Inventory reconciliation"],
      ["Display refresh + POSM placement", "Customer courtesy call"],
      ["Stock count + expiry check", "Delivery follow-up with depot in-charge"],
      ["Weekly sales review with manager", "Return goods pickup"],
    ]
    for (let back = 6; back >= 0; back--) {
      const dayIso = iso(new Date(NOW.getTime() - back * 86_400_000))
      const jitter = () => ri(-10, 10) // day-to-day variation so days don't look cloned
      if (back > 0) {
        const [taskA, taskB] = dayTasks[(6 - back) % dayTasks.length]
        await seedFieldDay("EMP-0007", dayIso, {
          a: "Jamuna Future Park Outlet", b: "Uttara Showroom",
          departHome: 485 + jitter(), aArrive: 520 + jitter(), aDepart: 645 + jitter(),
          teaArrive: 675 + jitter(), teaDepart: 700 + jitter(),
          bArrive: 735 + jitter(), bDepart: 860 + jitter(),
          tasksA: taskA, tasksB: taskB,
        })
        await seedFieldDay("EMP-0008", dayIso, {
          a: "Bashundhara City Branch", b: "Narayanganj Depot",
          departHome: 520 + jitter(), aArrive: 528 + jitter(), aDepart: 655 + jitter(),
          teaArrive: 683 + jitter(), teaDepart: 708 + jitter(),
          bArrive: 763 + jitter(), bDepart: 880 + jitter(),
          tasksA: "Quarterly compliance visit", tasksB: "Inventory reconciliation",
        })
        // EMP-0009: wandering trail + one MISSED visit (planned, never checked
        // in) on the missed-visit day (yesterday) for the compliance math
        if (back === 1) {
          seedWanderDay("EMP-0009", dayIso, [[23.8062, 90.3689], [23.7965, 90.3782], [23.8120, 90.3590]], 570)
          const empId = empIds["EMP-0009"]
          if (empId) {
            const plan = await db.visitPlan.findFirst({ where: { vendorId: finix.id, employeeId: empId, date: dayIso } })
              .then((p) => p ?? db.visitPlan.create({ data: { vendorId: finix.id, employeeId: empId, date: dayIso } }))
            const item = await db.visitPlanItem.findFirst({ where: { planId: plan.id, locationId: locIds["Uttara Showroom"] } })
              .then((i) => i ?? db.visitPlanItem.create({ data: { vendorId: finix.id, planId: plan.id, locationId: locIds["Uttara Showroom"], plannedFrom: "10:00", plannedTo: "12:00", tasks: "Follow-up collection" } }))
            await db.visit.findFirst({ where: { planItemId: item.id } }).then((v) => v ?? db.visit.create({
              data: { vendorId: finix.id, employeeId: empId, planItemId: item.id, locationId: locIds["Uttara Showroom"], checkInAt: wall(dayIso, 585), status: "MISSED", remarks: "SEED-DEMO: no check-in recorded within the window." },
            }))
          }
        }
      } else {
        // ---- TODAY: align the routed trail with the legacy plan/visit rows -
        await seedFieldDay("EMP-0007", dayIso, {
          a: "Jamuna Future Park Outlet", b: "Uttara Showroom",
          departHome: 515, aArrive: 568, aDepart: 705, // dwell 09:28-11:45 contains the existing 09:34-11:41 visit
          teaArrive: 725, teaDepart: 753,
          bArrive: 778, bDepart: 895, // dwell 12:58-14:55, visit 13:05-14:50
          tasksA: "Monthly stock audit + display check", tasksB: "Sales pitch, new winter collection",
        })
        await seedFieldDay("EMP-0008", dayIso, {
          a: "Bashundhara City Branch", b: "Narayanganj Depot",
          departHome: 590, aArrive: 598, aDepart: 716, // dwell 09:58-11:56, visit 10:02-11:51
          adHoc: { at: [23.7522, 90.3961], arrive: 728, depart: 778 }, // ad-hoc visit dwell 12:08-12:58 (visit 12:20-12:55)
          teaArrive: 805, teaDepart: 830,
          bArrive: 874, bDepart: 1012, // dwell 14:34-16:52, visit 14:38-16:47
          tasksA: "Quarterly compliance visit", tasksB: "Inventory reconciliation",
        })
        // today's ad-hoc visit for EMP-0008 (customer courtesy call, no plan
        // item) — pinned to the ad-hoc dwell spot of today's routed trail
        {
          const empId = empIds["EMP-0008"]
          if (empId) {
            await db.visit.findFirst({ where: { vendorId: finix.id, employeeId: empId, planItemId: null, remarks: { contains: "SEED-DEMO ad-hoc" } } }).then(async (v) => {
              const checkInAt = wall(TODAY, 740) // 12:20
              return v ? v : db.visit.create({
                data: {
                  vendorId: finix.id, employeeId: empId, planItemId: null, locationId: locIds["Bashundhara City Branch"],
                  checkInAt, checkInLat: 23.7522, checkInLng: 90.3961, checkInAccuracy: 18,
                  checkOutAt: wall(TODAY, 775), checkOutLat: 23.7524, checkOutLng: 90.3964,
                  durationMin: 35, status: "COMPLETED", remarks: "SEED-DEMO ad-hoc: customer courtesy call near Bashundhara City.",
                },
              })
            })
          }
        }
        seedWanderDay("EMP-0009", dayIso, [[23.8062, 90.3689], [23.8120, 90.3590]], 540)
        seedWanderDay("EMP-0010", dayIso, [[23.7465, 90.3772], [23.7561, 90.3872]], 560)
      }
    }

    // complete the legacy ad-hoc visit (check-out fields were missing)
    {
      const empId = empIds["EMP-0008"]
      if (empId) {
        const v = await db.visit.findFirst({ where: { vendorId: finix.id, employeeId: empId, planItemId: null, remarks: { contains: "SEED-DEMO ad-hoc" } } })
        if (v && !v.checkOutAt) {
          await db.visit.update({
            where: { id: v.id },
            data: {
              checkOutAt: wall(TODAY, 775), checkOutLat: 23.7524, checkOutLng: 90.3964,
              durationMin: 35,
            },
          })
        }
      }
    }

    for (let i = 0; i < points.length; i += 500) {
      await db.trackingPoint.createMany({ data: points.slice(i, i + 500), skipDuplicates: true })
    }

    // ---- live tracking states for the map/filters --------------------------
    const liveSpec: Record<string, { status: string; battery: number; net: string }[]> = {
      "EMP-0007": [{ status: "TRACKING", battery: 62, net: "4G" }],
      "EMP-0008": [{ status: "OUTSIDE_GEOFENCE", battery: 38, net: "4G" }],
      "EMP-0009": [{ status: "LOW_BATTERY", battery: 12, net: "WIFI" }],
      "EMP-0010": [{ status: "TRACKING", battery: 74, net: "5G" }],
    }
    for (const [code, specList] of Object.entries(liveSpec)) {
      const empId = empIds[code]
      if (!empId) continue
      const spec = specList[0]
      const mine = points.filter((p) => p.employeeId === empId && p.clientEventId.startsWith(`seed-ff-${code}-${TODAY}`))
      const last = mine.length ? mine[mine.length - 1] : null
      await db.employeeTrackingState.upsert({
        where: { employeeId: empId },
        create: {
          vendorId: finix.id, employeeId: empId, deviceId: "SEED-DEMO", trackingEnabled: true,
          trackingStatus: spec.status,
          lastSeenAt: last ? last.timestamp : new Date(Date.now() - ri(1, 9) * 60000),
          latitude: last ? last.latitude : homes[code][0],
          longitude: last ? last.longitude : homes[code][1],
          accuracyM: last ? last.accuracyM : ri(8, 40),
          batteryPercentage: spec.battery, isCharging: false, gpsStatus: "ON", networkStatus: spec.net,
          sessionStartedAt: wall(TODAY, 480),
        },
        update: {
          deviceId: "SEED-DEMO", trackingEnabled: true, trackingStatus: spec.status,
          lastSeenAt: last ? last.timestamp : new Date(Date.now() - ri(1, 9) * 60000),
          latitude: last ? last.latitude : homes[code][0],
          longitude: last ? last.longitude : homes[code][1],
          accuracyM: last ? last.accuracyM : ri(8, 40),
          batteryPercentage: spec.battery, gpsStatus: "ON", networkStatus: spec.net,
        },
      })
    }

    const visitCount = await db.visit.count({ where: { vendorId: finix.id } })
    const pingCount = await db.trackingPoint.count({ where: { vendorId: finix.id, deviceId: "SEED-DEMO" } })
    console.log(`✓ field force + tracking dummy data: ${visitLocations.length} visit locations, 7 days of routed plans/visits (${visitCount} visits), ${pingCount} TrackingPoints with dwell stops (deviceId SEED-DEMO)`)
  }

  // ============ SaaS platform layer (plans + owner console + demo data) ============
  try {
    const { seedSaaSLayer } = await import("./saas/seed-saas")
    const lines = await seedSaaSLayer({ demo: true })
    console.log("\n── SaaS layer (plans, owner console, demo registrations/subscriptions) ──")
    lines.forEach((l) => console.log("  " + l))
  } catch (e: any) {
    console.error("  [seed] SaaS layer seeding failed:", e?.message || e)
  }

  console.log("\n================ SEED COMPLETE ================")
  {
    const [empCount, userCount, attCount, entryCount, runCount] = await Promise.all([
      db.employee.count(), db.user.count(), db.attendance.count(), db.payrollEntry.count(), db.payrollRun.count(),
    ])
    console.log(`Corpus: ${empCount.toLocaleString()} employees · ${userCount.toLocaleString()} users · ${attCount.toLocaleString()} attendance rows · ${runCount.toLocaleString()} payroll runs / ${entryCount.toLocaleString()} entries`)
  }
  console.log("Login accounts (password: Pass@123):")
  userDefs.forEach(([email, , role]) => console.log(`  ${email.padEnd(38)} ${role}`))
  if (BULK_USERS > 0 && bulkIds.length > 0) {
    console.log(`  loadtest001…${String(Math.min(BULK_USERS, bulkIds.length)).padStart(3, "0")}@bengaltextworks.example  EMPLOYEE (bulk load-test accounts)`)
  }
  console.log("  owner@rongintraders.com                    VENDOR_OWNER (tenant #2)")
  console.log("=============================================")

  clearTimeout(seedTimeout)
}

function toMin(t: string) { const [h, m] = t.split(":").map(Number); return h * 60 + m }
function toHHMM(m: number) { m = Math.max(0, Math.min(1439, m)); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` }

main().catch((e) => { console.error("SEED FAILED:", e); process.exit(1) }).finally(() => db.$disconnect?.())

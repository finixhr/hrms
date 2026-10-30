// ============ Sandbox verification — 2026-10 round pure logic ============
// PostgreSQL is unavailable in this sandbox (tests/preload.ts runs
// `prisma db push` before ANY bun test file loads), so the bun:test suite
// cannot execute here. This script verifies the PURE engine logic directly
// (module imports construct PrismaClient lazily — no connection is made).
// The full bun:test files (tests/unit/*-2026-round) run the same assertions
// on a machine with PostgreSQL.
import {
  policyInSchedule, zonedParts, trackingConfig, multipleCheckinConfig,
  type PolicyRecord,
} from "../src/hrm-server/attendance-policy"
import { analyzeLocationIntegrity, integrityToEventStatus } from "../src/hrm-server/location-integrity"
import { evaluateFence, evaluateFences, haversineM } from "../src/hrm-server/geo"
import { validatePayout, type PayoutSettings, type ResolvedPayout } from "../src/hrm-server/payout"
import { exportColumns, renderCsv, renderXlsx, renderPdf, type ExportRow, type ExportTotals, type SalaryExportResult } from "../src/hrm-server/salary-export"
import { rateLimit } from "../src/hrm-server/rate-limit"

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++ } else { fail++; console.error(`  ✗ FAIL: ${name}`) }
}

// ---------- policy schedule ----------
const base: PolicyRecord = {
  id: "p1", vendorId: "v1", name: "P", policyType: "TRACKING", priority: 0,
  startDate: null, endDate: null, startTime: null, endTime: null,
  daysOfWeek: "SUNDAY,MONDAY,TUESDAY,WEDNESDAY,THURSDAY", timezone: "Asia/Dhaka",
  active: true, configJson: "{}",
}
console.log("policy engine (§6–§7)…")
check("no restrictions → in schedule (fixed Monday)", policyInSchedule(base, new Date("2026-10-05T12:00:00+06:00")) === true)
check("inactive → out", policyInSchedule({ ...base, active: false }, new Date("2026-10-05T12:00:00+06:00")) === false)
check("date range gates", policyInSchedule({ ...base, startDate: "2026-10-05", endDate: "2026-10-10" }, new Date("2026-10-07T12:00:00+06:00")) === true
  && policyInSchedule({ ...base, startDate: "2026-10-05", endDate: "2026-10-10" }, new Date("2026-10-11T12:00:00+06:00")) === false)
// 2026-10-02 = Friday (excluded), 2026-10-04 = Sunday (included)
check("Friday excluded from BD week", policyInSchedule(base, new Date("2026-10-02T11:00:00+06:00")) === false)
check("Sunday included", policyInSchedule(base, new Date("2026-10-04T11:00:00+06:00")) === true)
const win = { ...base, startTime: "09:00", endTime: "17:30" }
check("inside daily window", policyInSchedule(win, new Date("2026-10-04T10:00:00+06:00")) === true)
check("before window", policyInSchedule(win, new Date("2026-10-04T08:59:00+06:00")) === false)
check("after window", policyInSchedule(win, new Date("2026-10-04T17:31:00+06:00")) === false)
const night = { ...base, startTime: "22:00", endTime: "06:00" }
check("midnight-crossing window honored", policyInSchedule(night, new Date("2026-10-05T23:30:00+06:00")) === true
  && policyInSchedule(night, new Date("2026-10-05T12:00:00+06:00")) === false)
// 20:00 UTC Oct 4 = 02:00 Dhaka Oct 5 → outside; 06:00 UTC = 12:00 Dhaka → inside
check("timezone conversion respected", policyInSchedule(win, new Date("2026-10-04T20:00:00Z")) === false
  && policyInSchedule(win, new Date("2026-10-04T06:00:00Z")) === true)
const zp = zonedParts(new Date("2026-10-04T18:30:00Z"), "Asia/Dhaka")
check("zonedParts Dhaka day/weekday", zp.d === "05" && zp.weekday === "MONDAY")
check("unknown tz falls back to UTC", zonedParts(new Date("2026-10-04T18:30:00Z"), "Nope/Zone").d === "04")
check("trackingConfig defaults", trackingConfig(null).updateIntervalSec === 60)
check("multipleCheckinConfig defaults", multipleCheckinConfig(null).minIntervalMinutes === 60)

// ---------- location integrity ----------
console.log("location integrity (§24–§25)…")
const CFG = { maxAccuracyM: 150, suspiciousAction: "REVIEW" as const }
const NOW = new Date("2026-10-05T10:00:00Z")
const clean = analyzeLocationIntegrity({ latitude: 23.8103, longitude: 90.4125, accuracyM: 20, clientTimestamp: NOW.toISOString() }, null, NOW, CFG)
check("clean fix → VERIFIED/ALLOW", clean.status === "VERIFIED" && clean.decision === "ALLOW")
const mock = analyzeLocationIntegrity({ latitude: 23.8103, longitude: 90.4125, accuracyM: 20, isMockLocation: true }, null, NOW, CFG)
check("mock flag → MOCK_LOCATION/REVIEW", mock.status === "MOCK_LOCATION" && mock.decision === "REVIEW")
const prev = { latitude: 23.8103, longitude: 90.4125, at: new Date(NOW.getTime() - 60_000) }
const jump = analyzeLocationIntegrity({ latitude: 23.8553, longitude: 90.4125, accuracyM: 20 }, prev, NOW, CFG)
check("5km/60s → IMPOSSIBLE_MOVEMENT", jump.status === "IMPOSSIBLE_MOVEMENT")
const jumpReject = analyzeLocationIntegrity({ latitude: 23.8553, longitude: 90.4125, accuracyM: 20 }, prev, NOW, { maxAccuracyM: 150, suspiciousAction: "REJECT" })
check("REJECT policy escalates impossible movement", jumpReject.decision === "REJECT")
const walk = analyzeLocationIntegrity({ latitude: 23.8112, longitude: 90.4125, accuracyM: 20 }, prev, NOW, CFG)
check("walking speed stays VERIFIED", walk.status === "VERIFIED")
const stale = analyzeLocationIntegrity({ latitude: 23.8103, longitude: 90.4125, accuracyM: 20, clientTimestamp: new Date(NOW.getTime() - 20 * 60_000).toISOString() }, null, NOW, CFG)
check("20-min-old fix → STALE_LOCATION", stale.status === "STALE_LOCATION")
const skew = analyzeLocationIntegrity({ latitude: 23.8103, longitude: 90.4125, accuracyM: 20, clientTimestamp: new Date(NOW.getTime() - 7 * 60_000).toISOString() }, null, NOW, CFG)
check("clock skew → TIMESTAMP_ANOMALY", skew.status === "TIMESTAMP_ANOMALY")
const frozen = analyzeLocationIntegrity({ latitude: 23.8103, longitude: 90.4125, accuracyM: 20 }, { ...prev, at: new Date(NOW.getTime() - 5 * 60_000) }, NOW, CFG)
check("frozen GPS → SUSPICIOUS repeated", frozen.status === "SUSPICIOUS" && frozen.signals.includes("repeated_identical_location"))
const lowAcc = analyzeLocationIntegrity({ latitude: 23.8103, longitude: 90.4125, accuracyM: 400 }, null, NOW, CFG)
check("accuracy 400m → LOW_ACCURACY", lowAcc.status === "LOW_ACCURACY")
const perfect = analyzeLocationIntegrity({ latitude: 23.8103, longitude: 90.4125, accuracyM: 0.5 }, null, NOW, CFG)
check("0.5m 'accuracy' → SUSPICIOUS", perfect.status === "SUSPICIOUS")
const mismatch = analyzeLocationIntegrity({ latitude: 23.8103, longitude: 90.4125, accuracyM: 20, deviceId: "B", boundDeviceId: "A" }, null, NOW, CFG)
check("device mismatch → DEVICE_MISMATCH", mismatch.status === "DEVICE_MISMATCH")
check("ALLOW → ACCEPTED (never VERIFIED §27)", integrityToEventStatus(clean) === "ACCEPTED")
check("REVIEW → REVIEW_REQUIRED", integrityToEventStatus(mock) === "REVIEW_REQUIRED")

// ---------- geofence ----------
console.log("geo-fence evaluation (§22–§23)…")
const FENCE = { id: "f1", name: "Head Office", type: "CIRCLE", latitude: 23.8103, longitude: 90.4125, radiusM: 150, startTime: "09:00", endTime: "17:30", active: true }
const NOON = new Date("2026-10-05T12:00:00+06:00")
check("inside fence + good accuracy → ok", evaluateFence(FENCE, 23.811, 90.4125, 25, { now: NOON }).ok === true)
const outside = evaluateFence(FENCE, 23.8203, 90.4125, 25, { now: NOON })
check("outside → actionable message", outside.ok === false && (outside.reason ?? "").includes("m from Head Office"))
check("boundary ~144m passes", evaluateFence(FENCE, 23.8103 - 0.0013, 90.4125, 10, { now: NOON }).ok === true)
const poor = evaluateFence(FENCE, 23.8103, 90.4125, 500, { now: NOON })
check("poor accuracy inside small fence → REVIEW", poor.ok === false && (poor.reason ?? "").startsWith("REVIEW:"))
check("disabled fence → disabled reason", evaluateFence({ ...FENCE, active: false }, 23.8103, 90.4125, 20, { now: NOON }).reason === "Geo-fence is disabled")
const evening = new Date("2026-10-05T18:30:00+06:00")
check("outside fence hours → rejected", (evaluateFence(FENCE, 23.8103, 90.4125, 20, { now: evening }).reason ?? "").includes("Outside geo-fence hours"))
const twoFences = [FENCE, { ...FENCE, id: "f2", name: "Client Site A", latitude: 23.7503, longitude: 90.4125, radiusM: 200 }]
check("multi-fence: closest passing wins", evaluateFences(twoFences, 23.7503, 90.4125, 20, { now: NOON }).fence?.name === "Client Site A")
check("haversine ~111km/degree", haversineM(23, 90, 24, 90) > 110_000 && haversineM(23, 90, 24, 90) < 112_500)

// ---------- payout ----------
console.log("payout rules (§45/§81 matrix)…")
const S: PayoutSettings = { bankEnabled: true, cashEnabled: true, mfsEnabled: true, maxCashMfsSalary: 10_000, thresholdBasis: "GROSS" }
const bankAcc = { id: "a1", bank: "BRAC", branch: "Gulshan", holderName: "R", accountNumber: "1701", routingNumber: "060", mfsProvider: null, mfsNumber: null }
const mfsAcc = { ...bankAcc, bank: null, branch: null, accountNumber: null, routingNumber: null, mfsProvider: "BKASH", mfsNumber: "017" }
const res = (method: any, account: any): ResolvedPayout => ({ method, account })
check("9,000 → all three allowed", validatePayout(res("BANK", bankAcc), 9000, S).ok && validatePayout(res("CASH", null), 9000, S).ok && validatePayout(res("MFS", mfsAcc), 9000, S).ok)
check("10,000 (== threshold) → allowed", validatePayout(res("CASH", null), 10000, S).ok === true)
check("10,001 → cash blocked", validatePayout(res("CASH", null), 10001, S).ok === false)
check("10,001 → MFS blocked", validatePayout(res("MFS", mfsAcc), 10001, S).ok === false)
check("10,001 → BANK ok", validatePayout(res("BANK", bankAcc), 10001, S).ok === true)
check("15,000 → bank-only message", (validatePayout(res("CASH", null), 15000, S).reasons[0] ?? "").includes("not allowed above"))
check("bank without account → rejected", validatePayout(res("BANK", { ...bankAcc, accountNumber: null }), 5000, S).ok === false)
check("null method + 8,000 → CASH allowed (legacy)", validatePayout(res(null, null), 8000, S).ok === true)
check("null method + 15,000 → blocked (§78)", validatePayout(res(null, null), 15000, S).ok === false)
check("cash disabled blocks null-method legacy", validatePayout(res(null, null), 5000, { ...S, cashEnabled: false }).ok === false)

// ---------- export ----------
console.log("salary export shaping (§49–§53)…")
const allKeys = exportColumns("ALL").map((c) => c.key)
check("ALL has gross/ot/bonus/deductions/ait/net/payoutMethod", ["gross", "ot", "bonus", "deductions", "ait", "net", "payoutMethod"].every((k) => allKeys.includes(k as any)))
const bankKeys = exportColumns("BANK").map((c) => c.key)
check("BANK has account columns", ["bank", "bankBranch", "accountNumber", "routingNumber"].every((k) => bankKeys.includes(k as any)))
check("BANK has no payoutMethod noise", !bankKeys.includes("payoutMethod"))
const cashKeys = exportColumns("CASH").map((c) => c.key)
check("CASH has signature column + no bank data", cashKeys.includes("signatureCol") && !cashKeys.includes("bank") && !cashKeys.includes("accountNumber"))
const mfsKeys = exportColumns("MFS").map((c) => c.key)
check("MFS has provider/number", mfsKeys.includes("mfsProvider") && mfsKeys.includes("mfsNumber"))
const r: ExportRow = { code: "EMP-0001", fullName: "Rahim", designation: "Officer", department: "Sales", branch: "HO", gross: 15000, ot: 500, bonus: 1000, deductions: 500, ait: 250, net: 15750, payoutMethod: "BANK", bank: "BRAC", bankBranch: "Gulshan", accountName: "Rahim", accountNumber: "17012045", routingNumber: "060", mfsProvider: null, mfsAccountName: null, mfsNumber: null }
const t: ExportTotals = { employees: 1, gross: 15000, ot: 500, bonus: 1000, deductions: 500, ait: 250, net: 15750 }
const d: SalaryExportResult = { rows: [r], totals: t, runLabel: "2026-10", skipped: [] }
const csvOut = renderCsv("ALL", d)
check("CSV has header + row + TOTAL", csvOut.includes("Employee ID") && csvOut.includes("EMP-0001") && csvOut.includes("TOTAL"))
const bankCsv = renderCsv("BANK", d)
check("bank CSV includes account number", bankCsv.includes("17012045"))
check("cash CSV excludes account number", !renderCsv("CASH", d).includes("17012045"))
const xlsx = renderXlsx("ALL", d, "2026-10")
check("XLSX is a real zip container", xlsx.length > 1000 && xlsx.slice(0, 2).toString() === "PK")
const pdf = await renderPdf("ALL", d, "2026-10", "Test Co")
check("PDF is a real PDF", Buffer.from(pdf.slice(0, 5)).toString().startsWith("%PDF"))

// ---------- rate limit ----------
console.log("rate limiter (§66)…")
const k = `verify:${Date.now()}`
let limited = true
for (let i = 0; i < 3; i++) limited = rateLimit(k, 3, 60000).ok
check("allows within limit", limited === true)
check("blocks past the limit", rateLimit(k, 3, 60000).ok === false)
check("independent keys unaffected", rateLimit(`${k}-other`, 3, 60000).ok === true)

console.log(`\n===== sandbox verification: ${pass} passed, ${fail} failed =====`)
if (fail > 0) process.exit(1)

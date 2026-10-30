/// <reference types="bun-types" />
// ============ T-16 — export honesty: no success without delivered bytes ====
// Directive: never show export success unless the file was actually generated
// and delivered. This suite pins the FAILURE and DELIVERY paths of every
// money- and report-critical export action at the real POST /api/hrm
// boundary:
//
//   · payroll.export.salary  — 404 on unknown run; 400 on a cancelled run;
//     404 when no entries match the filters; 403 when BANK export is
//     requested without bankInfo.view; each format returns REAL bytes
//     (csv text / xlsx ZIP magic / pdf magic) with truthful totals.
//   · attendance.events.export — rowCount and csv lines must MATCH the rows
//     actually delivered; truncated stays false under the cap.
//   · pf.template.download — base64 that decodes to a real XLSX workbook,
//     even for a tenant with zero employees (an empty-but-valid template is
//     an honest deliverable; a missing one is a failure).
//
// The web-UI toast audit (toast fires only AFTER the blob is clicked, with
// counts from the response — never before generation) is recorded in
// IMPLEMENTATION_CHANGELOG.md; the one silent-no-op client path found
// (PF template download without base64) now errors loudly (payroll.tsx).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, mkEmployee, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let token: string
let vendorId: string
let runId: string
let emp1: { id: string; code: string }
let emp2: { id: string; code: string }

beforeAll(async () => {
  const vendor = await mkVendor("T16 Export Vendor")
  vendorId = vendor.id
  const owner = await mkUser(vendorId, { role: "VENDOR_OWNER", name: "T16 Owner" })
  token = await mkSession(owner.id, "FULL")

  emp1 = await mkEmployee(vendorId, { code: uniq("T16A"), fullName: "T16 Emp One" })
  emp2 = await mkEmployee(vendorId, { code: uniq("T16B"), fullName: "T16 Emp Two" })
  // emp1 is DESIGNATED for BANK payouts but has no account rows — the
  // honest-empty path for a BANK export (skipped with a visible reason).
  await db.employee.update({ where: { id: emp1.id }, data: { salaryPayoutMethod: "BANK" } as any })

  const run = await db.payrollRun.create({
    data: {
      vendorId, periodMonth: 10, periodYear: 2026, periodWeek: 0,
      frequency: "MONTHLY", runType: "REGULAR", status: "APPROVED", createdBy: owner.id,
    },
  })
  runId = run.id
  // Two INCLUDED entries — no payout rows planted, so both resolve to CASH.
  for (const [emp, gross, net] of [[emp1, 50000, 45000], [emp2, 30000, 27000]] as const) {
    await db.payrollEntry.create({
      data: { vendorId, runId: run.id, employeeId: emp.id, gross: gross as number, net: net as number, status: "INCLUDED" },
    })
  }
})

describe("T-16 · payroll.export.salary — failure is loud, success delivers bytes", () => {
  test("unknown runId → 404 with the reason (no empty-sheet success)", async () => {
    const r = await postHrm("payroll.export.salary", { runId: "nonexistent-run", type: "ALL", format: "csv" }, { bearer: token })
    expect(r.status).toBe(404)
    expect(String(r.body?.error || "")).toContain("not found")
  })

  test("cancelled run → 400 — void money must never export as a payable sheet", async () => {
    const cancelled = await db.payrollRun.create({
      data: {
        vendorId, periodMonth: 11, periodYear: 2026, periodWeek: 0,
        frequency: "MONTHLY", runType: "REGULAR", status: "CANCELLED", createdBy: "x",
      },
    })
    const r = await postHrm("payroll.export.salary", { runId: cancelled.id, type: "ALL", format: "csv" }, { bearer: token })
    expect(r.status).toBe(400)
    expect(String(r.body?.error || "")).toContain("cancelled")
  })

  test("filters that match nothing → 404 (no silent empty workbook)", async () => {
    const r = await postHrm("payroll.export.salary", { runId, type: "ALL", format: "csv", employeeId: "no-such-employee" }, { bearer: token })
    expect(r.status).toBe(404)
    expect(String(r.body?.error || "")).toContain("No payroll entries match")
  })

  test("BANK export without bankInfo.view → 403 (the account-detail gate)", async () => {
    // A custom role that may export payroll but must NOT see bank account
    // details (per-user grants are additive-only; narrowing below a built-in
    // template is what custom roles are for — roles.save semantics).
    await db.role.create({
      data: {
        vendorId, key: "T16_EXPORTER", name: "T16 Exporter",
        permissions: JSON.stringify(["payroll.view", "payroll.export"]), mfaRequired: false,
      } as any,
    })
    const officer = await mkUser(vendorId, { role: "T16_EXPORTER", name: "T16 NoBank" })
    const officerToken = await mkSession(officer.id, "FULL")
    const r = await postHrm("payroll.export.salary", { runId, type: "BANK", format: "csv" }, { bearer: officerToken })
    expect(r.status).toBe(403)
    expect(String(r.body?.error || "")).toContain("bankInfo.view")
  })

  test("csv → real text: header + one line per entry + totals footer, truthful totals", async () => {
    const r = await postHrm("payroll.export.salary", { runId, type: "ALL", format: "csv" }, { bearer: token })
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.format).toBe("csv")
    expect(String(d.filename).endsWith(".csv")).toBe(true)
    // header + two employees + the totals footer row
    const lines = String(d.csv).trimEnd().split("\n")
    expect(lines.length).toBe(4)
    expect(d.totals.employees).toBe(2)
    expect(d.totals.net).toBe(72000) // 45000 + 27000 — the REAL sum, not a placeholder
    expect(d.totals.gross).toBe(80000)
    // both employee codes actually appear in the delivered text
    expect(String(d.csv)).toContain(emp1.code)
    expect(String(d.csv)).toContain(emp2.code)
  })

  test("xlsx → base64 that decodes to a real workbook (ZIP magic PK)", async () => {
    const r = await postHrm("payroll.export.salary", { runId, type: "ALL", format: "xlsx" }, { bearer: token })
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(String(d.filename).endsWith(".xlsx")).toBe(true)
    expect(typeof d.base64).toBe("string")
    expect(d.base64.length).toBeGreaterThan(500) // a workbook, not a stub
    const bytes = Buffer.from(d.base64, "base64")
    expect(bytes.length).toBeGreaterThan(500)
    expect(bytes[0]).toBe(0x50); expect(bytes[1]).toBe(0x4b) // 'P','K' — xlsx IS a zip
    expect(d.totals.employees).toBe(2)
  })

  test("pdf → base64 that decodes to a real PDF (%PDF magic)", async () => {
    const r = await postHrm("payroll.export.salary", { runId, type: "ALL", format: "pdf" }, { bearer: token })
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(String(d.filename).endsWith(".pdf")).toBe(true)
    const bytes = Buffer.from(d.base64, "base64")
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF")
    expect(bytes.length).toBeGreaterThan(500)
  })

  test("BANK export with a designated-but-accountless employee → 200 with a visible skip list (honest empty)", async () => {
    // emp1: salaryPayoutMethod=BANK, no BankAccount rows → skipped with the
    // configuration reason; emp2 is CASH and simply not part of a BANK sheet.
    const r = await postHrm("payroll.export.salary", { runId, type: "BANK", format: "csv" }, { bearer: token })
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.totals.employees).toBe(0)
    expect(Array.isArray(d.skipped)).toBe(true)
    expect(d.skipped.length).toBe(1)
    expect(String(d.skipped[0].reason)).toMatch(/account/i)
  })

  test("the export is audit-logged with real totals", async () => {
    const rows = await db.auditLog.findMany({
      where: { vendorId, action: "payroll.export.all", entity: "PayrollRun", entityId: runId },
      orderBy: { createdAt: "desc" }, take: 1,
    })
    expect(rows.length).toBe(1)
    expect(String(rows[0].summary)).toContain("2 employees")
    expect(String(rows[0].summary)).toContain("72,000") // en-IN grouping of ৳72,000
  })
})

describe("T-16 · attendance.events.export — rowCount matches delivered lines", () => {
  test("three events → rowCount 3, truncated false, header + 3 csv lines", async () => {
    // three events for emp1 within the window
    for (const [i, type, method] of [[0, "CHECK_IN", "GEOFENCE"], [1, "CHECK_OUT", "GEOFENCE"], [2, "DEVICE_PUNCH", "DEVICE_PUNCH"]] as const) {
      await db.attendanceEvent.create({
        data: {
          vendorId, employeeId: emp1.id, eventType: type as string, attendanceMethod: method as string,
          status: "OK", occurredAt: new Date(`2026-10-15T${String(8 + (i as number)).padStart(2, "0")}:00:00Z`), source: "WEB",
        },
      })
    }
    const r = await postHrm("attendance.events.export", { from: "2026-10-01", to: "2026-10-31", format: "csv" }, { bearer: token })
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.rowCount).toBe(3)
    expect(d.truncated).toBe(false)
    const lines = String(d.csv).trimEnd().split("\n")
    expect(lines.length).toBe(4) // header + 3
    expect(String(d.csv)).toContain(emp1.code)
  })
})

describe("T-16 · pf.template.download — a template is always real bytes", () => {
  test("tenant with employees → decodable XLSX workbook with a filename", async () => {
    const r = await postHrm("pf.template.download", { filter: "ALL" }, { bearer: token })
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(String(d.fileName).endsWith(".xlsx")).toBe(true)
    const bytes = Buffer.from(String(d.base64), "base64")
    expect(bytes.length).toBeGreaterThan(500)
    expect(bytes[0]).toBe(0x50); expect(bytes[1]).toBe(0x4b)
  })

  test("tenant with ZERO matching employees still gets a valid (empty) template — not a failure", async () => {
    const emptyVendor = await mkVendor("T16 PF Empty")
    const owner2 = await mkUser(emptyVendor.id, { role: "VENDOR_OWNER", name: "T16 PF Owner" })
    const t2 = await mkSession(owner2.id, "FULL")
    const r = await postHrm("pf.template.download", { filter: "ELIGIBLE" }, { bearer: t2 })
    expect(r.status).toBe(200)
    const bytes = Buffer.from(String(r.body.data.base64), "base64")
    expect(bytes.length).toBeGreaterThan(500) // header rows only — still a workbook
    expect(bytes[0]).toBe(0x50); expect(bytes[1]).toBe(0x4b)
  })
})

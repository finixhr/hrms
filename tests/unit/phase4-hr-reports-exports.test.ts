/// <reference types="bun-types" />
// ============ Phase 4 — HR Reports & Analytics overhaul: FILTERS + EXPORTS regressions ============
// Companion to phase4-hr-reports-gating.test.ts (catalog hygiene / subscription
// tier / export permissions). This file pins:
//   G4 — the dynamic filter bar is applied SERVER-SIDE (one handler per
//        fix-family: attendanceOvertime approval status, employeesExits
//        from/to window, loans branch scoping, payroll runType, attritionRate
//        branch scoping, and the contract's honest filters mirror)
//   G5 — export file contents: the PDF header ("Applied filters:" only when
//        filters were applied), the CSV comment preamble, the XLSX info
//        block, and the scheduled legacy PDF lane (real PDF bytes — the old
//        silent XLSX fallback is gone)
//   G6 — the E2E background generation lane: analytics.report.generate →
//        BgJob → artifact with the right contentType + magic bytes
import "./_testdb"
import { describe, test, expect } from "bun:test"
import zlib from "node:zlib"
import * as XLSX from "xlsx"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, makeCtx, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { renderAnalyticsReport, reportToCsv, type AnalyticsReport } from "@/hrm-server/analytics-report"
import { renderReportPdf } from "@/hrm-server/report-pdf"
import { buildStructuredReportFile, buildReportFile } from "@/hrm-server/scheduled-reports"

/** One fresh multi-branch/multi-department vendor world per test (the
 *  r4-reporting pattern — dedicated vendors keep fixture populations from
 *  bleeding across filter assertions). */
async function filterWorld(tag: string) {
  const v = await mkVendor(uniq(tag))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: `${tag} Owner` })
  const token = await mkSession(u.id, "FULL")
  const branchA = await db.branch.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: `${tag} North`, code: uniq("BN") } })
  const branchB = await db.branch.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: `${tag} South`, code: uniq("BS") } })
  const deptA = await db.department.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: `${tag} Engineering`, code: uniq("DE") } })
  const deptB = await db.department.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: `${tag} Sales`, code: uniq("DS") } })
  return { v, u, token, branchA, branchB, deptA, deptB }
}

async function mkEmp(
  vendorId: string,
  over: { fullName: string; branchId?: string | null; departmentId?: string | null; status?: string; joiningDate?: string },
) {
  return db.employee.create({
    data: { companyId: await defaultCompanyId(vendorId),
      vendorId, fullName: over.fullName, code: uniq("E"),
      branchId: over.branchId ?? null, departmentId: over.departmentId ?? null,
      joiningDate: over.joiningDate ?? "2025-01-01",
      employmentType: "PERMANENT", status: over.status ?? "ACTIVE",
    },
  })
}

/** Decode every PDF stream (Flate-compressed or raw) into latin1 text so the
 *  header lines ("Period:", "Applied filters:", the title) can be asserted —
 *  the same structural-check intent as phase3-enterprise-delivery's
 *  PDFDocument round-trip, extended to the drawn text. pdf-lib emits the
 *  drawn strings as <hex> operands, so those are decoded too. */
function pdfStreamText(buf: Buffer): string {
  let raw = ""
  let idx = 0
  for (;;) {
    const s = buf.indexOf("stream", idx)
    if (s === -1) break
    let start = s + 6
    if (buf[start] === 13) start++
    if (buf[start] === 10) start++
    const e = buf.indexOf("endstream", start)
    if (e === -1) break
    const chunk = buf.subarray(start, e)
    try {
      raw += zlib.inflateSync(chunk).toString("latin1")
    } catch {
      raw += chunk.toString("latin1")
    }
    idx = e + 9
  }
  // decode the <hex> string operands the content stream draws text with
  return raw.replace(/<([0-9A-Fa-f\s]+)>/g, (_m, hex: string) => {
    const clean = String(hex).replace(/\s+/g, "")
    let out = ""
    for (let i = 0; i + 1 < clean.length; i += 2) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16))
    }
    return out
  })
}

// ---------------------------------------------------------------------- G4 ---
describe("G4 — dynamic filters are applied server-side", () => {
  test("attendanceOvertime status=PENDING returns only pending-OT rows (otApproved=false), APPROVED only approved", async () => {
    const { v, token } = await filterWorld("finP4ot")
    const e = await mkEmp(v.id, { fullName: "P4 OT Staff" })
    // November 2026: one APPROVED OT day (90m) + one PENDING OT day (60m)
    await db.attendance.create({ data: { vendorId: v.id, employeeId: e.id, date: "2026-11-01", status: "PRESENT", workingMinutes: 480, overtimeMinutes: 90, otApproved: true } })
    await db.attendance.create({ data: { vendorId: v.id, employeeId: e.id, date: "2026-11-02", status: "PRESENT", workingMinutes: 460, overtimeMinutes: 60, otApproved: false } })

    const pending = await postHrm("reports.attendanceOvertime", { month: 11, year: 2026, status: "PENDING" }, { bearer: token })
    expect(pending.status).toBe(200)
    expect(pending.body.data.meta.totalOvertimeMinutes).toBe(60) // ONLY the pending row
    expect(pending.body.data.meta.count).toBe(1)

    const approved = await postHrm("reports.attendanceOvertime", { month: 11, year: 2026, status: "APPROVED" }, { bearer: token })
    expect(approved.status).toBe(200)
    expect(approved.body.data.meta.totalOvertimeMinutes).toBe(90) // ONLY the approved row

    const all = await postHrm("reports.attendanceOvertime", { month: 11, year: 2026 }, { bearer: token })
    expect(all.body.data.meta.totalOvertimeMinutes).toBe(150) // absent ⇒ both
  })

  test("employeesExits from/to window excludes an exit outside the window", async () => {
    const { v, token } = await filterWorld("finP4ex")
    const inWindow = await mkEmp(v.id, { fullName: "P4 Exit In", status: "RESIGNED" })
    const outWindow = await mkEmp(v.id, { fullName: "P4 Exit Out", status: "TERMINATED" })
    await db.resignation.create({ data: { vendorId: v.id, employeeId: inWindow.id, submissionDate: "2026-02-01", resignationDate: "2026-02-15", proposedLwd: "2026-03-20", actualLwd: "2026-03-15", reason: "Relocation", status: "ACCEPTED" } })
    await db.resignation.create({ data: { vendorId: v.id, employeeId: outWindow.id, submissionDate: "2026-08-01", resignationDate: "2026-08-15", proposedLwd: "2026-09-25", actualLwd: "2026-09-30", reason: "Career move", status: "ACCEPTED" } })

    const r = await postHrm("reports.employeesExits", { from: "2026-01-01", to: "2026-06-30" }, { bearer: token })
    expect(r.status).toBe(200)
    const rows = r.body.data.rows as any[]
    expect(rows.length).toBe(1) // the September exit is outside the window
    expect(String(rows[0][1])).toContain("P4 Exit In")
    expect(String(rows[0][5])).toBe("2026-03-15") // Last Working Day column
    // absent bounds keep the previous behavior (all exits)
    const all = await postHrm("reports.employeesExits", {}, { bearer: token })
    expect(all.body.data.rows.length).toBe(2)
  })

  test("loans branchId returns only loans of employees in that branch", async () => {
    const { v, token, branchA, branchB } = await filterWorld("finP4ln")
    const ea = await mkEmp(v.id, { fullName: "P4 Loan A", branchId: branchA.id })
    const eb = await mkEmp(v.id, { fullName: "P4 Loan B", branchId: branchB.id })
    await db.loan.create({ data: { vendorId: v.id, employeeId: ea.id, principal: 1000, installments: 2, installmentAmount: 500, startDate: "2026-01-01", outstanding: 1000, status: "ACTIVE" } })
    await db.loan.create({ data: { vendorId: v.id, employeeId: eb.id, principal: 500, installments: 1, installmentAmount: 500, startDate: "2026-01-01", outstanding: 500, status: "ACTIVE" } })

    const r = await postHrm("reports.loans", { branchId: branchA.id }, { bearer: token })
    expect(r.status).toBe(200)
    const rows = r.body.data.rows as any[]
    expect(rows.length).toBe(1)
    expect(String(rows[0][0])).toContain("P4 Loan A")
    const all = await postHrm("reports.loans", {}, { bearer: token })
    expect(all.body.data.rows.length).toBe(2)
  })

  test("payroll runType filter selects that run type (REGULAR default, ADJUSTMENT on request, honest empty when none)", async () => {
    const { v, token } = await filterWorld("finP4pr")
    const e = await mkEmp(v.id, { fullName: "P4 Payroll Staff" })
    const regular = await db.payrollRun.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 11, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "PAID" } })
    await db.payrollEntry.create({ data: { vendorId: v.id, runId: regular.id, employeeId: e.id, gross: 5000, net: 4500, status: "INCLUDED" } })
    const adj = await db.payrollRun.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 11, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "ADJUSTMENT", adjustRunId: regular.id, adjustSeq: 1, status: "PAID" } })
    await db.payrollEntry.create({ data: { vendorId: v.id, runId: adj.id, employeeId: e.id, gross: -500, net: -450, status: "INCLUDED" } })

    const def = await postHrm("reports.payroll", { month: 11, year: 2026 }, { bearer: token })
    expect(def.status).toBe(200)
    expect(def.body.data.meta.run.id).toBe(regular.id) // absent ⇒ REGULAR
    expect(Number(def.body.data.rows[0][3])).toBe(5000)

    const adjusted = await postHrm("reports.payroll", { month: 11, year: 2026, runType: "ADJUSTMENT" }, { bearer: token })
    expect(adjusted.status).toBe(200)
    expect(adjusted.body.data.meta.run.id).toBe(adj.id) // the filter picks the adjustment run
    expect(Number(adjusted.body.data.rows[0][3])).toBe(-500)

    // a month with no payable run of the requested type is honestly empty
    const none = await postHrm("reports.payroll", { month: 12, year: 2026 }, { bearer: token })
    expect(none.status).toBe(200)
    expect(none.body.data.meta.run).toBe(null)
    expect(none.body.data.rows).toEqual([])
  })

  test("attritionRate branchId scoping: the empty branch renders all-zero rows while the unscoped year shows the exit", async () => {
    const { v, token, branchA, branchB } = await filterWorld("finP4at")
    await mkEmp(v.id, { fullName: "P4 Attr One", branchId: branchA.id, joiningDate: "2025-01-01" })
    await mkEmp(v.id, { fullName: "P4 Attr Two", branchId: branchA.id, joiningDate: "2025-06-01" })
    const gone = await mkEmp(v.id, { fullName: "P4 Attr Gone", branchId: branchA.id, joiningDate: "2025-01-01", status: "RESIGNED" })
    await db.resignation.create({ data: { vendorId: v.id, employeeId: gone.id, submissionDate: "2026-02-01", resignationDate: "2026-02-15", proposedLwd: "2026-03-20", actualLwd: "2026-03-15", reason: "Relocation", status: "ACCEPTED" } })

    const all = await postHrm("reports.attritionRate", { year: 2026 }, { bearer: token })
    expect(all.status).toBe(200)
    const march = (all.body.data.rows as any[]).find((row) => String(row[0]) === "March 2026")
    expect(march).toBeTruthy()
    expect(Number(march[4])).toBe(1) // the exit lands in its exit month
    expect(String(march[5])).not.toBe("0%")

    // branchB has NO employees: every month row is zero under the scope —
    // the scoping provably changed the population behind the rate math
    const scoped = await postHrm("reports.attritionRate", { year: 2026, branchId: branchB.id }, { bearer: token })
    expect(scoped.status).toBe(200)
    for (const row of scoped.body.data.rows as any[]) {
      expect(Number(row[1])).toBe(0) // headcount (start)
      expect(Number(row[4])).toBe(0) // exits
      expect(String(row[5])).toBe("0%") // annualized rate, format-agnostic
    }
  })

  test("analytics.report.render mirrors the applied filter back (report.filters) AND scopes the table", async () => {
    const { v, token, branchA } = await filterWorld("finP4mir")
    await mkEmp(v.id, { fullName: "P4 Mirror A", branchId: branchA.id })
    await mkEmp(v.id, { fullName: "P4 Mirror B" })

    const r = await postHrm("analytics.report.render", { reportId: "legacy.employees", branchId: branchA.id }, { bearer: token })
    expect(r.status).toBe(200)
    const rep = r.body.data
    // the contract mirrors the caller-supplied filter that was APPLIED
    expect(rep.filters).toEqual({ branchId: branchA.id })
    expect(rep.table.rows.length).toBe(1)
    expect(String(rep.table.rows[0][1])).toContain("P4 Mirror A")

    const unfiltered = await postHrm("analytics.report.render", { reportId: "legacy.employees" }, { bearer: token })
    expect(unfiltered.status).toBe(200)
    expect(unfiltered.body.data.table.rows.length).toBe(2)
    expect(unfiltered.body.data.filters).toEqual({}) // nothing applied, honestly
  })
})

// ---------------------------------------------------------------------- G5 ---
describe("G5 — export file contents (PDF / CSV / XLSX)", () => {
  test("PDF: title + period + 'Applied filters:' ride the header; the line is OMITTED when no filters were applied", async () => {
    const { v, u, branchA } = await filterWorld("finP4pdf")
    await mkEmp(v.id, { fullName: "P4 Pdf A", branchId: branchA.id })
    await mkEmp(v.id, { fullName: "P4 Pdf B" })
    const ctx = makeCtx({ id: u.id, vendorId: v.id, role: "HR_ADMIN" }, ["reports.view", "reports.export"])

    // a real render with from/to + branch filters (deterministic period label)
    const report = await renderAnalyticsReport(ctx as any, "legacy.employeesNewJoiners", {
      from: "2026-01-01", to: "2026-12-31", branchId: branchA.id,
    })
    expect(report.filters).toEqual({ from: "2026-01-01", to: "2026-12-31", branchId: branchA.id })
    expect(report.title).toBe("New Joiners")

    const bytes = await renderReportPdf(report)
    const buf = Buffer.from(bytes)
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-") // a real PDF
    const text = pdfStreamText(buf)
    expect(text).toContain("New Joiners") // the title is drawn
    expect(text).toContain("Period: 2026-01-01") // the period line follows the title
    expect(text).toContain("Applied filters:") // the honest filter line follows the period
    expect(text).toContain(`Branch: ${branchA.id}`)
    expect(text).toContain("From: 2026-01-01")
    // the document parses back and carries the title metadata (phase3 pattern)
    const { PDFDocument } = await import("pdf-lib")
    const doc = await PDFDocument.load(bytes)
    expect(doc.getTitle()).toBe("New Joiners")

    // the no-filters render omits the line entirely
    const bare = await renderAnalyticsReport(ctx as any, "legacy.employees", {})
    expect(bare.filters).toEqual({})
    const bareText = pdfStreamText(Buffer.from(await renderReportPdf(bare)))
    expect(bareText).toContain("Period:")
    expect(bareText).not.toContain("Applied filters")
  })

  test("CSV: reportToCsv opens with the '# <title>' / '# Period:' / '# Filters:' comment block", () => {
    const report: AnalyticsReport = {
      contractVersion: 1,
      reportId: "legacy.attritionRate",
      title: "Attrition Rate",
      generatedAt: "2026-11-02T10:00:00.000Z",
      period: { from: "2026-01-01", to: "2026-10-31", label: "2026-01-01 → 2026-10-31", comparison: null },
      filters: { branchId: "br1", status: "PENDING", month: 3 },
      scope: { applied: false, description: "whole organization (unscoped role)" },
      kpis: [{ key: "legacy.rows", label: "Rows", value: 3, unit: "count", local: true, definition: "Row count of the legacy table payload." }],
      charts: [],
      table: { columns: [{ key: "m", label: "Month" }], rows: [["Mar"]] },
      warnings: [],
      methodology: { source: "s", definitions: {}, generatedBy: "g" },
    }
    const csv = reportToCsv(report)
    const lines = csv.split("\n")
    expect(lines[0]).toBe("# Attrition Rate") // the title comment
    expect(csv).toContain("# Period: 2026-01-01 → 2026-10-31")
    // human labels + month names (not raw keys/numbers)
    expect(csv).toContain("# Filters: Branch: br1, Status: PENDING, Month: March")
    // no filters ⇒ no Filters line at all
    const bare = reportToCsv({ ...report, filters: {} })
    expect(bare).not.toContain("# Filters:")
    expect(bare.split("\n")[0]).toBe("# Attrition Rate")
  })

  test("XLSX: buildStructuredReportFile's first sheet opens with the info block (title / period / filters)", async () => {
    const { v, u, branchA } = await filterWorld("finP4xl")
    await mkEmp(v.id, { fullName: "P4 Xlsx A", branchId: branchA.id })
    await mkEmp(v.id, { fullName: "P4 Xlsx B" })
    const ctx = makeCtx({ id: u.id, vendorId: v.id, role: "HR_ADMIN" }, ["reports.view", "reports.export"])
    const report = await renderAnalyticsReport(ctx as any, "legacy.employeesNewJoiners", {
      from: "2026-01-01", to: "2026-12-31", branchId: branchA.id,
    })

    const xlsx = await buildStructuredReportFile(report, "XLSX")
    expect(xlsx.contentType).toContain("spreadsheetml")
    expect(xlsx.content.subarray(0, 2).toString()).toBe("PK") // zip magic
    // the first sheet is the KPI sheet, and it opens with the info block
    const wb = XLSX.read(xlsx.content, { type: "buffer" })
    expect(wb.SheetNames[0]).toBe("KPIs")
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["KPIs"]!, { header: 1 }) as any[][]
    expect(String(rows[0][0])).toBe("New Joiners") // title
    const flat = JSON.stringify(rows)
    expect(flat).toContain("Period: 2026-01-01")
    expect(flat).toContain("Filters: From: 2026-01-01")
    expect(flat).toContain(`Branch: ${branchA.id}`)
    // the KPI table itself follows the info block
    expect(flat).toContain("KPI")
    void v
  })

  test("scheduled legacy template (format=PDF) produces real PDF bytes — the silent XLSX fallback is gone", async () => {
    const { v } = await filterWorld("finP4sched")
    // the small columns/rows fixture a legacy template render produces
    const built = await buildReportFile(v.id, "headcount", "PDF", ["Branch", "Headcount"], [["North", 3]], {})
    expect(built.contentType).toBe("application/pdf")
    expect(built.filename).toContain(".pdf")
    expect(built.content.subarray(0, 5).toString()).toBe("%PDF-")
    expect(built.content.subarray(0, 2).toString()).not.toBe("PK") // never XLSX bytes
    // the PDF renders through the structured adapter — business title present
    const text = pdfStreamText(built.content)
    expect(text).toContain("Headcount Distribution")

    // controls: the other legacy formats keep their shapes
    const xlsx = await buildReportFile(v.id, "headcount", "XLSX", ["Branch"], [["North"]], {})
    expect(xlsx.content.subarray(0, 2).toString()).toBe("PK")
    const csv = await buildReportFile(v.id, "headcount", "CSV", ["Branch"], [["North"]], {})
    expect(csv.content.subarray(0, 3).toString("hex")).toBe("efbbbf") // UTF-8 BOM
    expect(csv.contentType).toBe("text/csv; charset=utf-8")
  })
})

// ---------------------------------------------------------------------- G6 ---
describe("G6 — E2E background generation lane (submit → run → artifact)", () => {
  /** Submit a generation as the entitled caller, drain the BgJob lane and
   *  poll until DONE (the phase3-enterprise-delivery pattern, tightened to
   *  require completion). */
  async function generateAndWait(token: string, payload: Record<string, unknown>) {
    const sub = await postHrm("analytics.report.generate", payload, { bearer: token })
    expect(sub.status).toBe(200)
    const jobId = sub.body.data.jobId
    expect(jobId).toBeTruthy()
    const { drainJobs } = await import("@/hrm-server/jobs")
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250))
      await drainJobs()
      const poll = await postHrm("analytics.report.generation", { jobId }, { bearer: token })
      expect(poll.status).toBe(200)
      const st = poll.body.data.status
      if (st === "DONE") return poll.body.data
      if (st === "DEAD") throw new Error(`generation job died: ${poll.body.data.error}`)
    }
    const last = await postHrm("analytics.report.generation", { jobId }, { bearer: token })
    return last.body.data
  }

  test("PDF generation: legacy report → application/pdf artifact with %PDF- magic", async () => {
    const { v, token } = await filterWorld("finP4gen1")
    await mkEmp(v.id, { fullName: "P4 Gen A" })
    await mkEmp(v.id, { fullName: "P4 Gen B" })
    const out = await generateAndWait(token, { reportId: "legacy.employees", format: "PDF" })
    expect(out.status).toBe("DONE")
    expect(out.artifact.contentType).toBe("application/pdf")
    const bytes = Buffer.from(out.artifact.base64, "base64")
    expect(bytes.length).toBeGreaterThan(500) // non-empty artifact
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-")
    expect(out.artifact.rows).toBe(2)
    expect(out.artifact.format).toBe("pdf")
  })

  test("XLSX generation: native advanced report (LEGACY tenant) → spreadsheetml artifact with PK magic", async () => {
    const { v, token, branchA } = await filterWorld("finP4gen2")
    await mkEmp(v.id, { fullName: "P4 Gen X", branchId: branchA.id })
    const out = await generateAndWait(token, { reportId: "workforce.headcount", format: "XLSX", dimension: "branch" })
    expect(out.status).toBe("DONE")
    expect(out.artifact.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    const bytes = Buffer.from(out.artifact.base64, "base64")
    expect(bytes.subarray(0, 2).toString()).toBe("PK")
    expect(bytes.length).toBeGreaterThan(1000)
  })

  test("CSV generation: the forwarded branchId filter rides the payload into the artifact preamble", async () => {
    const { v, token, branchA } = await filterWorld("finP4gen3")
    await mkEmp(v.id, { fullName: "P4 Gen C", branchId: branchA.id })
    await mkEmp(v.id, { fullName: "P4 Gen D" })
    const out = await generateAndWait(token, { reportId: "legacy.employees", format: "CSV", branchId: branchA.id })
    expect(out.status).toBe("DONE")
    expect(out.artifact.contentType).toBe("text/csv; charset=utf-8")
    const bytes = Buffer.from(out.artifact.base64, "base64")
    expect(bytes.subarray(0, 3).toString("hex")).toBe("efbbbf") // BOM
    const text = bytes.toString("utf8")
    expect(text).toContain("# Employee Master List")
    expect(text).toContain(`# Filters: Branch: ${branchA.id}`)
    expect(out.artifact.rows).toBe(1) // the filter scoped the render
  })
})

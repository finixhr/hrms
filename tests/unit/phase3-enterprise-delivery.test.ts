/// <reference types="bun-types" />
// ============ Phase 3 — enterprise delivery regressions ============
// The scheduler learned the AnalyticsReport contract: templates may name
// structured report ids, the attachments gain PDF (charts + KPI commentary)
// and multi-sheet XLSX, recipients are validated at save AND re-verified at
// delivery for EVERY template (not just PII keys), and FAILED runs retry with
// backoff instead of waiting a full schedule window.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { runReportTemplate, isRetryDue, MAX_DELIVERY_RETRIES } from "@/hrm-server/scheduled-reports"
import { renderReportPdf, kpiCommentary } from "@/hrm-server/report-pdf"
import { buildStructuredReportFile } from "@/hrm-server/scheduled-reports"
import { backfillWorkforceSnapshots } from "@/hrm-server/workforce-snapshots"
import { renderAnalyticsReport } from "@/hrm-server/analytics-report"
import { makeCtx } from "./_fixtures"

const TODAY = "2026-11-01"

/** A minimal contract payload for the pure PDF tests. */
function sampleReport(): any {
  return {
    contractVersion: 1,
    reportId: "workforce.dashboard",
    title: "Workforce Dashboard (structured)",
    generatedAt: "2026-11-01T10:00:00.000Z",
    period: { from: "2026-01-01", to: "2026-10-31", label: "2026-01-01 → 2026-10-31", comparison: { from: "2025-01-01", to: "2025-10-31", label: "prev" } },
    filters: { dimension: "department" },
    scope: { applied: false, description: "whole organization (unscoped role)" },
    kpis: [
      { key: "headcount.total", label: "Headcount", value: 120, unit: "count", definition: "Employees in the caller's visibility scope at period end, all statuses.", previous: { value: 110, deltaPct: 9.1 } },
      { key: "workforce.attrition", label: "Attrition (period)", value: 8.3, unit: "percent", definition: "Exits in the period divided by average headcount over the period.", previous: { value: 6.1, deltaPct: 36.1 }, intent: "good-low" },
      { key: "payroll.cost", label: "Payroll cost (gross)", value: 5250000, unit: "currency", definition: "Sum of PAID payroll-run gross totals for the months of the period.", previous: { value: 5000000, deltaPct: 5 } },
    ],
    charts: [
      { key: "workforce.movement", kind: "bar", title: "Joiners and exits by month", purpose: "Where the headcount movement actually happened.", series: [{ name: "Joiners", points: [{ label: "Jul", value: 6 }, { label: "Aug", value: 4 }, { label: "Sep", value: 8 }] }, { name: "Exits", points: [{ label: "Jul", value: 2 }, { label: "Aug", value: 3 }, { label: "Sep", value: 1 }] }] },
      { key: "workforce.headcount_trend", kind: "line", title: "Headcount trend", purpose: "Whether the workforce is growing, flat or shrinking.", series: [{ name: "Total", points: [{ label: "Jan", value: 110 }, { label: "Feb", value: 112 }, { label: "Mar", value: 115 }, { label: "Apr", value: 118 }] }] },
      { key: "attendance.methods", kind: "donut", title: "Check-in method mix", purpose: "Which attendance channels the workforce actually uses.", series: [{ name: "Events", points: [{ label: "Biometric", value: 700 }, { label: "Geo-fence", value: 200 }, { label: "Web", value: 100 }] }] },
    ],
    table: {
      columns: [{ key: "month", label: "Month", align: "left" }, { key: "total", label: "Headcount", align: "right" }],
      rows: [["Jul 2026", 116], ["Aug 2026", 117], ["Sep 2026", 124]],
    },
    warnings: ["One employee has no date of birth recorded."],
    methodology: {
      source: "Monthly WorkforceSnapshot series and scoped Employee records",
      definitions: { "workforce.attrition": "period exits ÷ average headcount" },
      generatedBy: "structured report definition workforce.dashboard (contract v1, Phase 3)",
    },
  }
}

describe("enterprise PDF — renderReportPdf (pure over the contract payload)", () => {
  test("renders a valid multi-page PDF with header, commentary, KPI cards, vector charts, table, warnings, methodology", async () => {
    const bytes = await renderReportPdf(sampleReport())
    expect(bytes.length).toBeGreaterThan(5_000)
    const buf = Buffer.from(bytes)
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-")     // a real PDF
    expect(buf.subarray(-6).toString().trim().endsWith("%%EOF")).toBe(true)
    // reload with pdf-lib: the document parses, carries the title metadata and
    // spans multiple pages (content streams are Flate-compressed, so the
    // structural round-trip is the honest check)
    const { PDFDocument } = await import("pdf-lib")
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBeGreaterThan(1)
    expect(doc.getTitle()).toContain("Workforce Dashboard")
  })

  test("the KPI commentary writes one sentence per compared KPI, from the same numbers", () => {
    const sentences = kpiCommentary(sampleReport())
    expect(sentences.length).toBe(3)
    expect(sentences[0]).toContain("Headcount is 120, from 110 (+9.1% vs previous period)")
    expect(sentences[1]).toContain("Attrition (period) is 8.3%, from 6.1%")
    expect(sentences[2]).toContain("BDT 52,50,000") // en-IN grouping
  })

  test("a payload without comparisons still gets an honest commentary line", () => {
    const rep = sampleReport()
    rep.kpis = rep.kpis.map((k: any) => ({ ...k, previous: null }))
    const sentences = kpiCommentary(rep)
    expect(sentences.length).toBe(1)
    expect(sentences[0]).toContain("No KPI carries a previous-period comparison")
  })

  test("buildStructuredReportFile produces the three formats from one payload", async () => {
    const rep = sampleReport()
    const csv = await buildStructuredReportFile(rep, "CSV")
    expect(csv.contentType).toBe("text/csv; charset=utf-8")
    expect(csv.content.toString("utf8")).toContain("KPI,Value,Unit,Previous")
    expect(csv.content.subarray(0, 3).toString("hex")).toBe("efbbbf") // UTF-8 BOM

    const xlsx = await buildStructuredReportFile(rep, "XLSX")
    expect(xlsx.contentType).toContain("spreadsheetml")
    expect(xlsx.content.subarray(0, 2).toString()).toBe("PK") // zip magic

    const pdf = await buildStructuredReportFile(rep, "PDF")
    expect(pdf.contentType).toBe("application/pdf")
    expect(pdf.content.subarray(0, 5).toString()).toBe("%PDF-")
    expect(pdf.rows).toBe(3)
  })
})

describe("isRetryDue — the bounded backoff gate (pure)", () => {
  const now = new Date("2026-11-01T10:00:00Z")
  test("FAILED + attempts left + elapsed backoff = due", () => {
    expect(isRetryDue({ lastStatus: "FAILED", retryCount: 1, nextRetryAt: new Date("2026-11-01T09:00:00Z") }, now)).toBe(true)
  })
  test("not due when the backoff has not elapsed, the run succeeded, or attempts are exhausted", () => {
    expect(isRetryDue({ lastStatus: "FAILED", retryCount: 1, nextRetryAt: new Date("2026-11-01T11:00:00Z") }, now)).toBe(false)
    expect(isRetryDue({ lastStatus: "SENT", retryCount: 1, nextRetryAt: new Date("2026-11-01T09:00:00Z") }, now)).toBe(false)
    expect(isRetryDue({ lastStatus: "FAILED", retryCount: MAX_DELIVERY_RETRIES + 1, nextRetryAt: new Date("2026-11-01T09:00:00Z") }, now)).toBe(false)
    expect(isRetryDue({ lastStatus: "FAILED", retryCount: 1, nextRetryAt: null }, now)).toBe(false)
  })
})

describe("templates.save — structured ids, PDF format, save-time recipient validation", () => {
  async function templateWorld() {
    const v = await mkVendor(uniq("finTpl"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-Tpl Owner", email: `fin-tpl-${uniq()}@test.local` })
    const token = await mkSession(u.id, "FULL")
    return { v, u, token }
  }

  test("a template can name a STRUCTURED report id and the PDF format", async () => {
    const { token } = await templateWorld()
    const r = await postHrm("reports.templates.save", {
      name: `Workforce PDF ${uniq()}`,
      reportKey: "workforce.dashboard",
      format: "PDF",
      schedule: "MONTHLY",
      recipients: [{ email: "owner@finixhr.example" }],
      active: true,
    }, { bearer: token })
    // the owner address has no User/Employee row in this fixture world → the
    // save-time membership gate rejects it honestly
    expect(r.status).toBe(400)
    expect(r.body.error).toContain("must be members of this organization")
  })

  test("a member recipient saves fine — including for a non-PII structured report", async () => {
    const { v, u, token } = await templateWorld()
    const r = await postHrm("reports.templates.save", {
      name: `Workforce XLSX ${uniq()}`,
      reportKey: "workforce.dashboard",
      format: "XLSX",
      schedule: "MONTHLY",
      recipients: [{ email: u.email }],
      active: true,
    }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.template.format).toBe("XLSX")
    // structured filter validation at save time: an invalid dimension is rejected
    const bad = await postHrm("reports.templates.save", {
      name: `Bad filter ${uniq()}`,
      reportKey: "workforce.dashboard",
      format: "CSV",
      schedule: "OFF",
      recipients: [{ email: u.email }],
      active: false,
      filters: { dimension: "hairColor" },
    }, { bearer: token })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain("hairColor")
    void v
  })
})

describe("runReportTemplate — structured rendering, delivery verification, retry bookkeeping", () => {
  async function deliveryWorld() {
    const v = await mkVendor(uniq("finDeliv"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-Deliv Owner", email: `fin-deliv-${uniq()}@test.local` })
    // a second member who will LEAVE before the delivery (run-time re-verification)
    const leaver = await mkUser(v.id, { role: "HR_ADMIN", name: "FIN-Deliv Leaver", email: `fin-leaver-${uniq()}@test.local` })
    // employees so the structured report has data
    const a = await mkEmployee(v.id, { fullName: "Delivery staff A" })
    await db.employee.update({ where: { id: a.id }, data: { joiningDate: "2026-02-10" } })
    await backfillWorkforceSnapshots(v.id, 12, TODAY)
    // SMTP pointed at a closed port → sendEmail FAILS (not SKIPPED): exercises
    // the retry bookkeeping deterministically
    // HrSetting values are JSON-encoded (the loader parses them)
    await db.hrSetting.create({ data: { vendorId: v.id, group: "email", key: "enabled", value: "true" } })
    await db.hrSetting.create({ data: { vendorId: v.id, group: "email", key: "host", value: JSON.stringify("127.0.0.1") } })
    await db.hrSetting.create({ data: { vendorId: v.id, group: "email", key: "port", value: "1" } })
    await db.hrSetting.create({ data: { vendorId: v.id, group: "email", key: "username", value: JSON.stringify("u") } })
    await db.hrSetting.create({ data: { vendorId: v.id, group: "email", key: "password", value: JSON.stringify("p") } })
    return { v, u, leaver }
  }

  test("a FAILED structured delivery schedules a bounded retry (retryCount + nextRetryAt), not a month of silence", async () => {
    const { v, u } = await deliveryWorld()
    const t = await db.reportTemplate.create({
      data: { companyId: await defaultCompanyId(v.id),
        vendorId: v.id, reportKey: "workforce.dashboard", name: `Retry probe ${uniq()}`,
        filtersJson: "{}", format: "PDF", schedule: "MONTHLY",
        recipientsJson: JSON.stringify([{ email: u.email }]), active: true,
      },
    })
    const out = await runReportTemplate(v.id, t.id)
    expect(out.status).toBe("FAILED") // SMTP connection refused
    const row = await db.reportTemplate.findUnique({ where: { id: t.id } })
    expect(row!.retryCount).toBe(1)
    expect(row!.nextRetryAt).not.toBeNull()
    // the delivery HISTORY row was written for the attempt
    const log = await db.reportDeliveryLog.findFirst({ where: { templateId: t.id }, orderBy: { startedAt: "desc" } })
    expect(log!.status).toBe("FAILED")
    expect(log!.format).toBe("PDF")
  })

  test("a member who LEFT is dropped at delivery — the re-verification covers non-PII reports too", async () => {
    const { v, u, leaver } = await deliveryWorld()
    // leaver leaves the tenant before the run
    await db.user.update({ where: { id: leaver.id }, data: { status: "DISABLED" } })
    await db.user.delete({ where: { id: leaver.id } })
    const t = await db.reportTemplate.create({
      data: { companyId: await defaultCompanyId(v.id),
        vendorId: v.id, reportKey: "workforce.dashboard", name: `Leaver probe ${uniq()}`,
        filtersJson: "{}", format: "CSV", schedule: "MONTHLY",
        recipientsJson: JSON.stringify([{ email: u.email }, { email: leaver.email }]), active: true,
      },
    })
    const out = await runReportTemplate(v.id, t.id)
    // not SENT for a non-member on a NON-PII structured report (the old
    // run-time gate only covered PII keys)
    expect(out.status).toBe("SKIPPED")
    expect(out.detail).toContain("no longer members of this organization")
    expect(out.detail).toContain(leaver.email)
  })

  test("a LEGACY key still renders through the legacy lane (no regression)", async () => {
    const { v, u } = await deliveryWorld()
    const t = await db.reportTemplate.create({
      data: { companyId: await defaultCompanyId(v.id),
        vendorId: v.id, reportKey: "headcount", name: `Legacy probe ${uniq()}`,
        filtersJson: "{}", format: "CSV", schedule: "MONTHLY",
        recipientsJson: JSON.stringify([{ email: u.email }]), active: true,
      },
    })
    const out = await runReportTemplate(v.id, t.id)
    expect(out.status).toBe("FAILED") // SMTP refused — but it RENDERED (not "unknown report key")
    expect(out.detail).not.toContain("unknown report key")
    const log = await db.reportDeliveryLog.findFirst({ where: { templateId: t.id }, orderBy: { startedAt: "desc" } })
    expect(log!.reportKey).toBe("headcount")
  })

  test("maybeRunScheduledReports retries a FAILED template once its backoff elapsed", async () => {
    const { v, u } = await deliveryWorld()
    const t = await db.reportTemplate.create({
      data: { companyId: await defaultCompanyId(v.id),
        vendorId: v.id, reportKey: "workforce.dashboard", name: `Sched retry ${uniq()}`,
        filtersJson: "{}", format: "CSV", schedule: "MONTHLY",
        recipientsJson: JSON.stringify([{ email: u.email }]), active: true,
      },
    })
    // first run: FAILED (SMTP refused), retry scheduled with backoff
    await runReportTemplate(v.id, t.id)
    const row1 = await db.reportTemplate.findUnique({ where: { id: t.id } })
    expect(row1!.retryCount).toBe(1)
    // backoff not elapsed → a scheduler pass today does nothing
    const { maybeRunScheduledReports } = await import("@/hrm-server/scheduled-reports")
    const today = new Date().toISOString().slice(0, 10)
    await maybeRunScheduledReports(v.id, today)
    const row2 = await db.reportTemplate.findUnique({ where: { id: t.id } })
    expect(row2!.retryCount).toBe(1) // unchanged: nextRetryAt is in the future
    // backoff elapsed → the next pass retries (and fails again → attempt 2)
    await db.reportTemplate.update({ where: { id: t.id }, data: { nextRetryAt: new Date(Date.now() - 60_000) } })
    await maybeRunScheduledReports(v.id, today)
    const row3 = await db.reportTemplate.findUnique({ where: { id: t.id } })
    expect(row3!.retryCount).toBe(2)
    // every attempt is an auditable delivery-log row (the no-op pass — retry
    // not yet due — correctly writes nothing)
    const logs = await db.reportDeliveryLog.count({ where: { templateId: t.id } })
    expect(logs).toBe(2) // first run + retried run
  })
})

describe("background generation — the REPORT_GENERATE lane (submit → poll)", () => {
  test("analytics.report.generate + analytics.report.generation round-trip through the dispatcher", async () => {
    const v = await mkVendor(uniq("finGen"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-Gen Owner" })
    const token = await mkSession(u.id, "FULL")
    const a = await mkEmployee(v.id, { fullName: "Generation staff" })
    await db.employee.update({ where: { id: a.id }, data: { joiningDate: "2026-03-01" } })
    await backfillWorkforceSnapshots(v.id, 3, TODAY)

    const sub = await postHrm("analytics.report.generate", {
      reportId: "workforce.headcount", format: "PDF", dimension: "branch",
    }, { bearer: token })
    expect(sub.status).toBe(200)
    const jobId = sub.body.data.jobId
    expect(jobId).toBeTruthy()

    // drain the lane synchronously (submitJob kicks a drain; give it a moment)
    const { drainJobs } = await import("@/hrm-server/jobs")
    await new Promise((r) => setTimeout(r, 300))
    await drainJobs()
    await new Promise((r) => setTimeout(r, 300))

    const poll = await postHrm("analytics.report.generation", { jobId }, { bearer: token })
    expect(poll.status).toBe(200)
    const data = poll.body.data
    expect(["DONE", "RUNNING", "PENDING"]).toContain(data.status)
    if (data.status === "DONE") {
      expect(data.artifact.format).toBe("pdf")
      expect(Buffer.from(data.artifact.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-")
    }
    // the submission is audited
    const auditRow = await db.auditLog.findFirst({ where: { vendorId: v.id, action: "analytics.report.workforce.headcount.generateSubmitted" } })
    expect(auditRow).not.toBeNull()
  })

  test("a caller without the report's permission cannot submit a generation", async () => {
    const v = await mkVendor(uniq("finGenP"))
    const emp = await mkEmployee(v.id, { fullName: "No-perms staff" })
    const u = await mkUser(v.id, { role: "EMPLOYEE", name: "No Reports Gen", employeeId: emp.id })
    const token = await mkSession(u.id, "FULL")
    const r = await postHrm("analytics.report.generate", { reportId: "workforce.headcount", format: "PDF" }, { bearer: token })
    expect(r.status).toBe(403)
  })

  test("structured render through makeCtx with payroll.view absent hides financial blocks (wire gate holds for the scheduler ctx too)", async () => {
    const v = await mkVendor(uniq("finCtx"))
    const u = await mkUser(v.id, { role: "HR_ADMIN", name: "Ctx Admin" })
    await backfillWorkforceSnapshots(v.id, 2, TODAY)
    const ctx = makeCtx({ id: u.id, vendorId: v.id, role: "HR_ADMIN" }, ["reports.view"])
    const rep = await renderAnalyticsReport(ctx as any, "workforce.dashboard", { from: "2026-01-01", to: TODAY })
    expect(rep.kpis.map((k) => k.key)).not.toContain("payroll.cost")
  })
})

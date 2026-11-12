// ============ Scheduled report delivery (Wave 4 WP-A, 2026-10-08) ============
// Driven by the jobs tick: finds due ReportTemplate rows per vendor and emails
// the rendered report to the template's recipients via the tenant gateway.
// Every send lands in ReportDeliveryLog with the SENT/FAILED/SKIPPED contract.
// Date-guarded per template so a slow tick never double-sends.
//
// PHASE 3 — enterprise delivery:
//   · the scheduler LEARNED THE CONTRACT: a template's reportKey may name a
//     structured report (the analytics registry, e.g. "workforce.dashboard" or
//     "legacy.headcount") — rendered through renderAnalyticsReport with the
//     same synthetic SYSTEM ctx the legacy path uses, so scoping, PII gating
//     and every future fix apply identically;
//   · formats: CSV (reportToCsv), multi-sheet XLSX (KPIs / one sheet per chart
//     / table — summary + detail, not raw rows) and PDF (renderReportPdf:
//     charts + KPI commentary);
//   · recipients are validated AT SAVE (reports.templates.save, every
//     template) AND RE-VERIFIED AT DELIVERY (every template — the old
//     run-time check covered PII keys only): a member who left stops
//     receiving company reports, not just company PII;
//   · retry with backoff: a FAILED run retries on the next scheduler ticks
//     (nextRetryAt, up to MAX_DELIVERY_RETRIES) instead of waiting a full
//     schedule window; SENT/SKIPPED reset the counters. The auditable history
//     stays the ReportDeliveryLog rows — every attempt is a row.
//
// Render path (legacy keys): renderReportForVendor() — the SAME handlers the
// RPC dispatcher serves. One template failing NEVER breaks the loop: each run
// is individually try/caught and its outcome is always recorded.
import { db } from "@/lib/db"
import * as XLSX from "xlsx"
import { j } from "./utils"
import { sendEmail, type DeliveryResult } from "./gateway"
import { renderReportForVendor, isPiiReportKey, nonMemberRecipients, assertReportEntitlement } from "./routes/reports"
import { renderAnalyticsReport, reportToCsv, reportDefinition, describeFilters, type AnalyticsReport } from "./analytics-report"
import { EntitlementError } from "./saas/entitlements"
import { loggerFor } from "@/hrm-server/log"
const log = loggerFor("scheduled-reports")

type ReportRecipient = { email: string; name?: string }
type ReportTemplateRow = NonNullable<Awaited<ReturnType<typeof db.reportTemplate.findFirst>>>
export type TemplateRunResult = {
  status: "SENT" | "FAILED" | "SKIPPED"
  detail?: string
  rows?: number
  templateName: string
}

/** Phase 3 — a FAILED delivery retries at most this many times (then it waits
 *  for the next schedule window like the old behavior). */
export const MAX_DELIVERY_RETRIES = 3
/** Phase 3 — backoff between retries (scaled by attempt number). */
const RETRY_BACKOFF_MS = 15 * 60_000

/** Is this template due on `date` (UTC "YYYY-MM-DD")? Never-run ⇒ due.
 *  DAILY:   last run strictly before today.
 *  WEEKLY:  last run before this week's Monday AND today ≥ Monday.
 *  MONTHLY: last run before the 1st of this month AND today ≥ the 1st. */
export function isTemplateDue(schedule: string, lastRunAt: Date | null, date: string): boolean {
  // only scheduled templates are ever due (the scheduler also filters this in
  // its query; the guard keeps the exported function safe standalone)
  if (schedule !== "DAILY" && schedule !== "WEEKLY" && schedule !== "MONTHLY") return false
  if (!lastRunAt) return true
  const last = lastRunAt.toISOString().slice(0, 10)
  const d = new Date(`${date}T00:00:00Z`)
  switch (schedule) {
    case "DAILY":
      return last < date
    case "WEEKLY": {
      // Monday of the ISO week containing `date` (UTC arithmetic)
      const monday = new Date(d)
      monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
      const mondayStr = monday.toISOString().slice(0, 10)
      return date >= mondayStr && last < mondayStr
    }
    case "MONTHLY": {
      const first = `${date.slice(0, 7)}-01`
      return date >= first && last < first
    }
    default:
      return false
  }
}

/** Phase 3 — is a FAILED template retry-due right now? (bounded attempts,
 *  backoff elapsed). Used alongside isTemplateDue by the scheduler pass. */
export function isRetryDue(t: { lastStatus: string | null; retryCount: number; nextRetryAt: Date | null }, now = new Date()): boolean {
  return t.lastStatus === "FAILED"
    && t.retryCount > 0
    && t.retryCount <= MAX_DELIVERY_RETRIES
    && !!t.nextRetryAt
    && t.nextRetryAt.getTime() <= now.getTime()
}

/** One scheduler pass for a vendor. Cheap when nothing is due. Returns the
 *  number of templates actually run (any outcome). */
export async function maybeRunScheduledReports(vendorId: string, date: string): Promise<number> {
  const templates = await db.reportTemplate.findMany({
    where: { vendorId, active: true, schedule: { not: "OFF" } },
    orderBy: { createdAt: "asc" },
  })
  let ran = 0
  for (const t of templates) {
    const due = isTemplateDue(t.schedule, t.lastRunAt, date)
    // Phase 3 — a FAILED run with an elapsed backoff retries on THIS tick
    // (bounded by isRetryDue); a not-yet-due template with an open retry
    // window still runs, everything else waits for its schedule.
    const retry = !due && isRetryDue(t)
    if (!due && !retry) continue
    try {
      await runReportTemplate(vendorId, t.id)
      ran++
    } catch (e) {
      // NEVER let one template break the loop — record and move on.
      log.error(`[scheduled-reports] template "${t.name}" (${t.id}) failed`, e)
      try {
        await db.reportDeliveryLog.create({
          data: {
            vendorId,
            templateId: t.id,
            templateName: t.name,
            reportKey: t.reportKey,
            format: t.format,
            status: "FAILED",
            detail: String((e as any)?.message || e).slice(0, 300),
            recipientCount: j(t.recipientsJson, [] as ReportRecipient[]).length,
            startedAt: new Date(),
          },
        })
        await db.reportTemplate.update({
          where: { id: t.id },
          data: { lastRunAt: new Date(), lastStatus: "FAILED", ...(retryBookkeeping(t, "FAILED")) },
        })
      } catch (e2) {
        log.error("[scheduled-reports] failed to record the failure itself", e2)
      }
    }
  }
  return ran
}

/** Phase 3 — the retry bookkeeping for a finished run: FAILED retries (bounded,
 *  with backoff) instead of waiting a full schedule window; anything else
 *  resets. The auditable history is the ReportDeliveryLog rows either way. */
function retryBookkeeping(t: { retryCount: number }, status: "SENT" | "FAILED" | "SKIPPED") {
  if (status === "FAILED" && t.retryCount < MAX_DELIVERY_RETRIES) {
    const attempt = t.retryCount + 1
    return { retryCount: attempt, nextRetryAt: new Date(Date.now() + RETRY_BACKOFF_MS * attempt) }
  }
  return { retryCount: 0, nextRetryAt: null }
}

/** Excel sheet names: ≤31 chars, no []:*?/\ — report keys are camelCase-safe
 *  but the guard keeps this robust for any future key. */
function safeSheetName(key: string): string {
  const cleaned = key.replace(/[[\]:*?/\\]/g, "").slice(0, 31).trim()
  return cleaned || "Report"
}

/** The synthetic SYSTEM ctx the scheduler renders under (vendor-scoped,
 *  unscoped HR_ADMIN so an emailed company report covers the whole tenant).
 *  payroll.view rides the set because the legacy scheduler already emails
 *  payroll-run summaries under plain reports.view. */
function schedulerCtx(vendorId: string, companyId?: string | null) {
  return {
    userId: "scheduler",
    userName: "Report Scheduler",
    vendorId,
    // MULTI-COMPANY — the template's company scopes the render (null/undefined
    // = a tenant-wide template: the previous vendor-wide behavior)
    activeCompanyId: companyId || null,
    role: "HR_ADMIN" as const,
    permissions: new Set(["reports.view", "reports.schedule", "payroll.view"]),
  }
}

/** Build the attachment: XLSX via SheetJS (sheet = report key, header row +
 *  data rows, capped column widths) or CSV with a UTF-8 BOM so Excel renders
 *  Bangla text and ৳ correctly. (Legacy table payload.)
 *  STEP 4 (reports overhaul) — format=PDF now renders through the STRUCTURED
 *  adapter (legacy.<key> → renderAnalyticsReport → renderReportPdf): the old
 *  path only branched CSV, so a PDF template silently received XLSX bytes.
 *  CSV/XLSX paths are unchanged. Exported for the reports-overhaul regression
 *  tests (the scheduled-legacy-PDF magic-bytes contract) — same pattern as
 *  buildStructuredReportFile below. */
export async function buildReportFile(vendorId: string, reportKey: string, format: string, columns: string[], rows: unknown[][], filters: Record<string, unknown> = {}, companyId?: string | null): Promise<{
  filename: string
  content: Buffer
  contentType: string
}> {
  const stamp = new Date().toISOString().slice(0, 10)
  if (format === "PDF") {
    // MULTI-COMPANY — the structured PDF re-render rides the template's company
    const report = await renderAnalyticsReport(schedulerCtx(vendorId, companyId) as any, `legacy.${reportKey}`, filters as any)
    const { renderReportPdf } = await import("./report-pdf")
    return {
      filename: `finix-report-${reportKey}-${stamp}.pdf`,
      content: Buffer.from(await renderReportPdf(report)),
      contentType: "application/pdf",
    }
  }
  if (format === "CSV") {
    const escCell = (v: unknown) => {
      let s = v == null ? "" : String(v)
      // M-8 — formula-injection guard, same rule as utils.csv
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const body = [columns, ...rows].map((r) => r.map(escCell).join(",")).join("\r\n")
    return {
      filename: `finix-report-${reportKey}-${stamp}.csv`,
      content: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]),
      contentType: "text/csv; charset=utf-8",
    }
  }
  const ws = XLSX.utils.aoa_to_sheet([columns, ...rows])
  ws["!cols"] = columns.map((c, i) => ({
    wch: Math.min(42, Math.max(10, String(c).length + 2, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length + 2))),
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(reportKey))
  return {
    filename: `finix-report-${reportKey}-${stamp}.xlsx`,
    content: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }
}

/** Phase 3 — the STRUCTURED attachment from an AnalyticsReport contract
 *  payload: CSV (reportToCsv — the same data the UI renders), multi-sheet
 *  XLSX (KPI summary → one sheet per chart → table: summary + detail, not raw
 *  rows) or PDF (renderReportPdf — charts + KPI commentary). Exported: the
 *  background REPORT_GENERATE job builds the same artifact for on-demand
 *  downloads. */
export async function buildStructuredReportFile(report: AnalyticsReport, format: string): Promise<{
  filename: string
  content: Buffer
  contentType: string
  rows: number
}> {
  const stamp = new Date().toISOString().slice(0, 10)
  const base = report.reportId.replace(/[^a-z0-9.-]/gi, "-").slice(0, 40)
  const rows = report.table?.rows.length ?? 0
  if (format === "CSV") {
    return {
      filename: `finix-report-${base}-${stamp}.csv`,
      content: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(reportToCsv(report), "utf8")]),
      contentType: "text/csv; charset=utf-8",
      rows,
    }
  }
  if (format === "PDF") {
    const { renderReportPdf } = await import("./report-pdf")
    const pdf = await renderReportPdf(report)
    return {
      filename: `finix-report-${base}-${stamp}.pdf`,
      content: Buffer.from(pdf),
      contentType: "application/pdf",
      rows,
    }
  }
  // XLSX — multi-sheet: KPIs (with definitions + previous), one sheet per
  // chart's series, the table, warnings + methodology. STEP 7 (reports
  // overhaul) — the first sheet opens with the info block: report title,
  // period label, the applied filters (describeFilters — the SAME rendering
  // the PDF header and CSV preamble use) and the generated timestamp.
  const wb = XLSX.utils.book_new()
  const filtersLine = describeFilters(report.filters)
  const kpiSheet = XLSX.utils.aoa_to_sheet([
    [report.title],
    [`Period: ${report.period.label}`, report.period.comparison ? `Comparison: ${report.period.comparison.label}` : ""],
    ...(filtersLine ? [[`Filters: ${filtersLine}`]] : []),
    [`Scope: ${report.scope.description}`],
    [`Generated: ${report.generatedAt.replace("T", " ").slice(0, 19)} UTC`],
    [],
    ["KPI", "Value", "Unit", "Previous", "Δ%", "Definition"],
    ...report.kpis.map((k) => [
      k.label,
      k.value == null ? "" : k.value,
      k.unit,
      k.previous?.value == null ? "" : k.previous.value,
      k.previous?.deltaPct == null ? "" : `${k.previous.deltaPct > 0 ? "+" : ""}${k.previous.deltaPct}%`,
      k.definition,
    ]),
    [],
    ["Warnings"],
    ...report.warnings.map((w) => [w]),
    [],
    ["Methodology", report.methodology.source],
    ...Object.entries(report.methodology.definitions).map(([k, v]) => [k, v]),
  ])
  kpiSheet["!cols"] = [{ wch: 26 }, { wch: 16 }, { wch: 9 }, { wch: 16 }, { wch: 8 }, { wch: 80 }]
  XLSX.utils.book_append_sheet(wb, kpiSheet, safeSheetName("KPIs"))
  for (const chart of report.charts) {
    const ws = XLSX.utils.aoa_to_sheet([
      [chart.title],
      [chart.purpose],
      [],
      ...chart.series.map((s) => [s.name, ...s.points.map((p) => String(p.label))]),
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      ["", ...chart.series[0]!.points.map((p) => p.value)],
    ])
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    ws["!cols"] = chart.series[0]!.points.map(() => ({ wch: 14 }))
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(chart.key.slice(0, 28)))
  }
  if (report.table && report.table.rows.length) {
    const ws = XLSX.utils.aoa_to_sheet([
      report.table.columns.map((c) => c.label),
      ...report.table.rows,
    ])
    ws["!cols"] = report.table.columns.map((c) => ({ wch: Math.min(32, Math.max(10, c.label.length + 6)) }))
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName("Table"))
  }
  return {
    filename: `finix-report-${base}-${stamp}.xlsx`,
    content: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    rows,
  }
}

/** Phase 3 — render a STRUCTURED report for the scheduler: the same synthetic
 *  SYSTEM ctx the legacy path uses (vendor-scoped, unscoped HR_ADMIN so an
 *  emailed company report covers the whole tenant), routed through
 *  renderAnalyticsReport so the definition's own permission pair, filter
 *  validation and scope honesty all apply. payroll.view rides the synthetic
 *  set because the legacy scheduler already emails payroll-run summaries under
 *  plain reports.view — the financial blocks of the workforce dashboard are no
 *  more privileged than what the legacy lane sends, and recipients are
 *  validated tenant members. Returns null for unknown ids. */
async function renderStructuredForVendor(vendorId: string, reportKey: string, filters: Record<string, unknown>, companyId?: string | null): Promise<AnalyticsReport | null> {
  // "legacy.<key>" wraps a legacy handler — the adapter's definition carries
  // the legacy route's own permission pair; strip nothing here, the registry
  // knows both spellings.
  const def = reportDefinition(reportKey)
  if (!def) return null
  // Reports overhaul (STEP 8) — the scheduler's structured lane is tier-gated
  // like every interactive surface: a scheduled NATIVE advanced report
  // (workforce.dashboard …) is blocked when the tenant lost ADVANCED_REPORTS
  // (legacy keys were already gated by the reportRoute factory wrapper — the
  // natives had NO gate on this path). The thrown EntitlementError fails the
  // template run with the upgrade message (see the runReportTemplate call
  // site) instead of silently rendering a paid report the tenant no longer
  // holds.
  await assertReportEntitlement({ vendorId }, def.reportId)
  const ctx = {
    userId: "scheduler",
    userName: "Report Scheduler",
    vendorId,
    // MULTI-COMPANY — the template's company scopes the structured render too
    activeCompanyId: companyId || null,
    role: "HR_ADMIN" as const,
    permissions: new Set(["reports.view", "reports.schedule", "payroll.view", ...def.permission, ...def.exportPermission]),
  }
  return renderAnalyticsReport(ctx as any, reportKey, filters as any)
}

/** Render + email ONE template and record the outcome. Shared by the jobs
 *  scheduler AND reports.templates.runNow (on-demand). Throws only for
 *  "template not found"; every delivery failure is a recorded result. */
export async function runReportTemplate(vendorId: string, templateId: string): Promise<TemplateRunResult> {
  const t: ReportTemplateRow | null = await db.reportTemplate.findFirst({ where: { id: templateId, vendorId } })
  if (!t) throw new Error("Report template not found")
  const recipients = j(t.recipientsJson, [] as ReportRecipient[]).filter((r) => r && typeof r.email === "string")
  const filters = j(t.filtersJson, {} as Record<string, unknown>)

  const finish = async (status: TemplateRunResult["status"], detail: string | undefined, rows: number | null): Promise<TemplateRunResult> => {
    await db.reportTemplate.update({
      where: { id: t.id },
      data: { lastRunAt: new Date(), lastStatus: status, ...retryBookkeeping(t, status) },
    })
    await db.reportDeliveryLog.create({
      data: {
        vendorId,
        templateId: t.id,
        templateName: t.name,
        reportKey: t.reportKey,
        format: t.format,
        status,
        detail: detail ? detail.slice(0, 300) : null,
        recipientCount: recipients.length,
        rows: rows ?? undefined,
        startedAt: new Date(),
      },
    })
    return { status, detail, rows: rows ?? undefined, templateName: t.name }
  }

  if (!recipients.length) {
    return finish("SKIPPED", "no recipients configured", null)
  }

  // ---- recipient re-verification AT DELIVERY (Phase 3: EVERY template — the
  // old run-time gate covered PII keys only). A member who left the tenant
  // stops receiving company reports, not just company PII; outsiders turn the
  // scheduler into an exfiltration pipe even for aggregate numbers.
  const outsiders = await nonMemberRecipients(vendorId, recipients)
  if (outsiders.length) {
    const pii = isPiiReportKey(t.reportKey)
    return finish("SKIPPED",
      `${pii ? "PII report" : "Report"} not sent — recipient(s) are no longer members of this organization: ${outsiders.join(", ")}`,
      null)
  }

  // ---- render: structured contract first, legacy table second ----
  // STEP 4 (reports overhaul) — the reportKey lookup accepts BOTH spellings:
  // a bare legacy key ("employees") and its structured id ("legacy.employees")
  // name the same report. Full ids resolve natively in the structured lane;
  // `legacyBare` normalizes a full id back to the handler key so the legacy
  // lane finds its handler — and buildReportFile re-wraps it as legacy.<key>
  // when the template's format is PDF (see the PDF branch there).
  const legacyBare = t.reportKey.startsWith("legacy.") ? t.reportKey.slice("legacy.".length) : t.reportKey
  // MULTI-COMPANY — the template's companyId scopes BOTH render lanes (null =
  // a tenant-wide template, the previous vendor-wide behavior)
  const structured = await renderStructuredForVendor(vendorId, t.reportKey, filters, t.companyId).catch((e) => {
    // Reports overhaul (STEP 8) — an ENTITLEMENT failure must FAIL the run
    // honestly (recorded with the upgrade message by the caller's existing
    // FAILED outcome path): swallowing it here would fall back to the legacy
    // lane, which for a native id masks the lost ADVANCED_REPORTS entitlement
    // as a bogus "unknown report key" failure — and would still deliver the
    // report for a legacy advanced key. Render-time errors keep the previous
    // catch-to-null fallback (legacy lane for legacy keys).
    if (e instanceof EntitlementError) throw e
    return null
  })
  let file: { filename: string; content: Buffer; contentType: string }
  let title = reportTitleOfKey(t.reportKey)
  let rows: number
  if (structured) {
    const built = await buildStructuredReportFile(structured, t.format)
    file = built
    rows = built.rows
    title = structured.title
  } else {
    const rendered = await renderReportForVendor(vendorId, legacyBare, filters, t.companyId)
    if (!rendered) {
      return finish("FAILED", `unknown report key "${t.reportKey}" — the report was removed or renamed; re-save this template`, null)
    }
    file = await buildReportFile(vendorId, legacyBare, t.format, rendered.columns, rendered.rows, filters, t.companyId)
    rows = rendered.rows.length
    title = rendered.title
  }

  // Plain-text body — the gateway wraps it into HTML paragraphs (title,
  // filters, row count, generated timestamp, attached filename).
  const filterBits = Object.entries(filters)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}: ${String(v)}`)
  const genAt = `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`
  const body = [
    `Finix HR scheduled report — ${t.name}`,
    "",
    `Report: ${title}`,
    filterBits.length ? `Filters: ${filterBits.join(", ")}` : "Filters: none (whole company scope)",
    `Rows: ${rows}`,
    `Generated: ${genAt}`,
    structured?.warnings.length ? `Warnings: ${structured.warnings[0]}${structured.warnings.length > 1 ? ` (+${structured.warnings.length - 1} more)` : ""}` : "",
    "",
    `Attached: ${file.filename}`,
  ].filter((l) => l !== "").join("\n")
  const subject = `[Finix HR] ${title} — ${rows} rows (${t.format})`

  // sequential sends: gentle on the tenant SMTP transport, ordered in the log
  const results: DeliveryResult[] = []
  for (const r of recipients) {
    results.push(await sendEmail(vendorId, r.email, subject, body, {
      attachments: [{ filename: file.filename, content: file.content, contentType: file.contentType }],
    }))
  }
  const failed = results.filter((r) => r.status === "FAILED")
  const skipped = results.filter((r) => r.status === "SKIPPED")
  const firstOf = (list: DeliveryResult[]) => list.map((x) => x.detail).find(Boolean) || ""

  if (failed.length) {
    return finish("FAILED", `${failed.length}/${results.length} recipient(s) failed${firstOf(failed) ? ` — ${firstOf(failed)}` : ""}`, rows)
  }
  if (skipped.length) {
    // SENT only when ALL recipients were sent; a single skip (invalid address,
    // gateway off) downgrades the whole run to SKIPPED with the reason.
    return finish("SKIPPED", `${skipped.length}/${results.length} recipient(s) skipped${firstOf(skipped) ? ` — ${firstOf(skipped)}` : ""}`, rows)
  }
  return finish("SENT", `${results.length} recipient(s)`, rows)
}

function reportTitleOfKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/^legacy\./, "Legacy ")
}

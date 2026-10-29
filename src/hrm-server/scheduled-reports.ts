// ============ Scheduled report delivery (Wave 4 WP-A, 2026-10-08) ============
// Driven by the jobs tick: finds due ReportTemplate rows per vendor and emails
// the rendered report (xlsx/csv) to the template's recipients via the tenant
// gateway. Every send lands in ReportDeliveryLog with the SENT/FAILED/SKIPPED
// contract. Date-guarded per template so a slow tick never double-sends.
//
// Render path: the report is produced by renderReportForVendor() — the SAME
// handlers the RPC dispatcher serves — invoked with a synthetic SYSTEM ctx
// (vendor-scoped, HR_ADMIN scope so an emailed company report covers the
// whole tenant). One template failing NEVER breaks the loop: each run is
// individually try/caught and its outcome is always recorded.
import { db } from "@/lib/db"
import * as XLSX from "xlsx"
import { j } from "./utils"
import { sendEmail, type DeliveryResult } from "./gateway"
import { renderReportForVendor, isPiiReportKey, nonMemberRecipients } from "./routes/reports"

type ReportRecipient = { email: string; name?: string }
type ReportTemplateRow = NonNullable<Awaited<ReturnType<typeof db.reportTemplate.findFirst>>>
export type TemplateRunResult = {
  status: "SENT" | "FAILED" | "SKIPPED"
  detail?: string
  rows?: number
  templateName: string
}

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

/** One scheduler pass for a vendor. Cheap when nothing is due. Returns the
 *  number of templates actually run (any outcome). */
export async function maybeRunScheduledReports(vendorId: string, date: string): Promise<number> {
  const templates = await db.reportTemplate.findMany({
    where: { vendorId, active: true, schedule: { not: "OFF" } },
    orderBy: { createdAt: "asc" },
  })
  let ran = 0
  for (const t of templates) {
    if (!isTemplateDue(t.schedule, t.lastRunAt, date)) continue
    try {
      await runReportTemplate(vendorId, t.id)
      ran++
    } catch (e) {
      // NEVER let one template break the loop — record and move on.
      console.error(`[scheduled-reports] template "${t.name}" (${t.id}) failed`, e)
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
        // advance lastRunAt so a permanently broken template does not retry
        // (and re-fail + re-log) on EVERY 60s tick until fixed
        await db.reportTemplate.update({ where: { id: t.id }, data: { lastRunAt: new Date(), lastStatus: "FAILED" } })
      } catch (e2) {
        console.error("[scheduled-reports] failed to record the failure itself", e2)
      }
    }
  }
  return ran
}

/** Excel sheet names: ≤31 chars, no []:*?/\ — report keys are camelCase-safe
 *  but the guard keeps this robust for any future key. */
function safeSheetName(key: string): string {
  const cleaned = key.replace(/[[\]:*?/\\]/g, "").slice(0, 31).trim()
  return cleaned || "Report"
}

/** Build the attachment: XLSX via SheetJS (sheet = report key, header row +
 *  data rows, capped column widths) or CSV with a UTF-8 BOM so Excel renders
 *  Bangla text and ৳ correctly. */
function buildReportFile(reportKey: string, format: string, columns: string[], rows: unknown[][]): {
  filename: string
  content: Buffer
  contentType: string
} {
  const stamp = new Date().toISOString().slice(0, 10)
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

/** Render + email ONE template and record the outcome. Shared by the jobs
 *  scheduler AND reports.templates.runNow (on-demand). Throws only for
 *  "template not found"; every delivery failure is a recorded result. */
export async function runReportTemplate(vendorId: string, templateId: string): Promise<TemplateRunResult> {
  const t: ReportTemplateRow | null = await db.reportTemplate.findFirst({ where: { id: templateId, vendorId } })
  if (!t) throw new Error("Report template not found")
  const recipients = j(t.recipientsJson, [] as ReportRecipient[]).filter((r) => r && typeof r.email === "string")
  const filters = j(t.filtersJson, {} as Record<string, unknown>)

  const finish = async (status: TemplateRunResult["status"], detail: string | undefined, rows: number | null): Promise<TemplateRunResult> => {
    await db.reportTemplate.update({ where: { id: t.id }, data: { lastRunAt: new Date(), lastStatus: status } })
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

  // ---- RPT-001 (Wave R3-3) — run-time re-verification for PII-class reports ----
  // templates.save validates reports.pii + tenant membership at SAVE time, but
  // a member may have since left (user deleted, employee e-mail changed). The
  // scheduler refuses to e-mail bulk PII to a non-member instead of silently
  // shipping it; legacy templates saved before the gate existed are covered
  // by the same check (they get SKIPPED with the reason, never SENT).
  if (isPiiReportKey(t.reportKey)) {
    const outsiders = await nonMemberRecipients(vendorId, recipients)
    if (outsiders.length) {
      return finish("SKIPPED", `PII report not sent — recipient(s) are no longer members of this organization: ${outsiders.join(", ")}`, null)
    }
  }

  // ---- render through the SAME handlers the RPC dispatcher serves ----
  const rendered = await renderReportForVendor(vendorId, t.reportKey, filters)
  if (!rendered) {
    return finish("FAILED", `unknown report key "${t.reportKey}" — the report was removed or renamed; re-save this template`, null)
  }

  const file = buildReportFile(t.reportKey, t.format, rendered.columns, rendered.rows)

  // Plain-text body — the gateway wraps it into HTML paragraphs (title,
  // filters, row count, generated timestamp, attached filename).
  const filterBits = Object.entries(filters)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}: ${String(v)}`)
  const genAt = `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`
  const body = [
    `Finix HR scheduled report — ${t.name}`,
    "",
    `Report: ${rendered.title}`,
    filterBits.length ? `Filters: ${filterBits.join(", ")}` : "Filters: none (whole company scope)",
    `Rows: ${rendered.rows.length}`,
    `Generated: ${genAt}`,
    "",
    `Attached: ${file.filename}`,
  ].join("\n")
  const subject = `[Finix HR] ${rendered.title} — ${rendered.rows.length} rows (${t.format})`

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
    return finish("FAILED", `${failed.length}/${results.length} recipient(s) failed${firstOf(failed) ? ` — ${firstOf(failed)}` : ""}`, rendered.rows.length)
  }
  if (skipped.length) {
    // SENT only when ALL recipients were sent; a single skip (invalid address,
    // gateway off) downgrades the whole run to SKIPPED with the reason.
    return finish("SKIPPED", `${skipped.length}/${results.length} recipient(s) skipped${firstOf(skipped) ? ` — ${firstOf(skipped)}` : ""}`, rendered.rows.length)
  }
  return finish("SENT", `${results.length} recipient(s)`, rendered.rows.length)
}

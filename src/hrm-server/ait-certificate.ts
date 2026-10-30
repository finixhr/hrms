// ============ AIT / TDS salary tax slip (certificate) builder (spec §7D) ============
// Print-ready HTML certificate per employee (optionally per payroll month) —
// shows the full calculation breakdown with legal references, company and
// employee TINs, fiscal + assessment year and the bilingual disclaimer.
//
// Security: follows the payslip builder hardening — every interpolated value
// is HTML-escaped, a restrictive CSP is embedded and NO scripts ship; printing
// is triggered by the opener (openPrintWindow).
import { db } from "@/lib/db"
import { getSettings } from "./settings"
import { monthName } from "./utils"
import { escapeHtml } from "./security"
import { AIT_DISCLAIMER_BN, AIT_DISCLAIMER_EN, AitEngineConfig } from "@/hrm/shared/ait-engine"

export async function renderAitCertificateHtml(x: {
  vendorId: string
  employee: any
  entry?: any | null
  config: AitEngineConfig | null
  tdsYtd: number
  structure?: any | null
  periodLabel?: string | null
}): Promise<string> {
  const e = escapeHtml
  const vendor = await db.vendor.findUnique({ where: { id: x.vendorId } })
  const settings = await getSettings(x.vendorId)
  const emp = x.employee
  const desig = emp?.designationId ? await db.designation.findFirst({ where: { id: emp.designationId } }) : null
  const dept = emp?.departmentId ? await db.department.findFirst({ where: { id: emp.departmentId } }) : null
  const branch = emp?.branchId ? await db.branch.findFirst({ where: { id: emp.branchId } }) : null
  const cfg = x.config
  const bd = x.entry ? JSON.parse(x.entry.breakdownJson || "{}") : {}
  const aitBd: any = bd.ait || {}

  // ---- breakdown rows (new rich snapshot, or legacy shape, or structure-based estimate)
  const money = (n: any) => `৳ ${Number(n || 0).toLocaleString("en-IN")}`
  const rows: { l: string; r?: string; v?: string; strong?: boolean; grand?: boolean }[] = []
  const slabRows: { label: string; rate: string; amount: string; tax: string }[] = []
  let monthTds = 0
  if (aitBd.lines && Array.isArray(aitBd.lines)) {
    // new engine snapshot stored on the payroll entry
    for (const ln of aitBd.lines) {
      rows.push({ l: `${ln.n}. ${ln.label}${ln.ref ? ` — <span style="color:#64748b">[${e(ln.ref)}]</span>` : ""}`, v: ln.amount != null ? money(ln.amount) : (ln.text || "—"), strong: ln.kind === "total", grand: ln.kind === "grand" })
    }
    monthTds = Number(aitBd.monthlyTds || 0)
    for (const s of aitBd.slabLines || []) slabRows.push({ label: e(s.label), rate: `${Number(s.ratePercent)}%`, amount: money(s.amount), tax: money(s.tax) })
  } else if (x.entry) {
    // legacy entry (pre-rebuild): the essentials are still truthful
    const gross = Number(bd.gross || 0)
    rows.push({ l: "1. Monthly Gross Salary", v: money(gross) })
    rows.push({ l: `2. Annualized Gross (12 × gross)${Number(bd.bonus || 0) > 0 ? " + bonuses" : ""}`, v: money(gross * 12 + Number(bd.bonus || 0) + Number(bd.commission || 0)) })
    rows.push({ l: `8. Total Annual Tax (estimated)`, v: money(Number(aitBd.netMonthlyAit || x.entry.ait || 0) * 12), strong: true })
    rows.push({ l: `12. This Month's TDS`, v: money(x.entry.ait || 0), grand: true })
    rows.push({ l: `13. Year-to-Date TDS Deducted`, v: money(x.tdsYtd) })
    monthTds = Number(x.entry.ait || 0)
  } else {
    // no payroll history yet — structure-based projection note
    rows.push({ l: "No payroll history for this employee yet — figures below are the current projection.", v: "" })
    rows.push({ l: "Monthly Gross Salary (active structure)", v: money(x.structure?.gross || 0) })
    monthTds = 0
  }

  const companyTin = settings?.general?.binVatReg ? e(String(settings.general.binVatReg)) : "—"
  const period = x.periodLabel ? e(x.periodLabel) : (x.entry ? `${e(monthName(x.entry.periodMonth))} ${x.entry.periodYear}` : "—")
  const fyLabel = cfg ? `${e(cfg.label)} · Income Year ${e(cfg.incomeYear)} · Assessment Year ${e(cfg.assessmentYear)}` : "—"
  const secRef = cfg ? e(cfg.tdsSectionRef) : "Section 86, ITA 2023"
  const certNo = x.entry?.payslipNumber ? `TDS-${e(x.entry.payslipNumber)}` : `TDS-${e(emp?.code || "")}-${new Date().getFullYear()}`
  const warns: string[] = Array.isArray(aitBd.warnings) ? aitBd.warnings.map((w: any) => e(w.en || "")) : []

  const rowHtml = rows.map((r) => `<tr${r.grand ? ' style="background:linear-gradient(90deg,#064e3b,#047857);color:#fff;font-weight:700"' : r.strong ? ' style="font-weight:700;background:#f0fdf4"' : ""}><td>${r.l}</td><td style="text-align:right;white-space:nowrap">${r.v || ""}</td></tr>`).join("")
  const slabHtml = slabRows.length ? `
  <h4>Slab-wise Tax Breakdown — First Schedule (dynamic per fiscal year)</h4>
  <table>
    <tr style="background:#f8fafc"><th style="text-align:left">Slab</th><th>Rate</th><th>Amount</th><th style="text-align:right">Tax</th></tr>
    ${slabRows.map((s) => `<tr><td>${s.label}</td><td style="text-align:center">${s.rate}</td><td style="text-align:right">${s.amount}</td><td style="text-align:right;font-weight:600">${s.tax}</td></tr>`).join("")}
  </table>` : ""

  return `<!doctype html><html><head><meta charset="utf-8"><title>TDS Salary Tax Slip ${certNo}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'">
<style>
  body { font-family: 'Segoe UI', 'Noto Sans Bengali', Arial, sans-serif; color: #1e293b; margin: 0; padding: 24px; background: #fff; }
  .slip { max-width: 760px; margin: 0 auto; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; }
  .head { display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; background: #f8fafc; border-bottom: 2px solid #047857; gap: 12px; }
  .brand { font-size: 20px; font-weight: 700; color: #065f46; }
  .brand small { display: block; font-weight: 400; color: #64748b; font-size: 11px; }
  .meta { text-align: right; font-size: 12px; color: #475569; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid #e2e8f0; }
  .cell { padding: 8px 24px; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
  .cell b { color: #334155; }
  h4 { margin: 14px 24px 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #047857; }
  table { width: calc(100% - 48px); margin: 4px 24px 8px; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; }
  th { color: #475569; font-size: 11px; text-transform: uppercase; }
  .disc { margin: 12px 24px; padding: 10px 12px; border: 1px solid #f59e0b; background: #fffbeb; color: #78350f; font-size: 10.5px; border-radius: 6px; line-height: 1.6; }
  .sign { display: flex; justify-content: space-between; align-items: flex-end; padding: 18px 24px 8px; }
  .sign .box { text-align: center; font-size: 11px; color: #334155; }
  .sign .line { margin-top: 34px; border-top: 1px dashed #94a3b8; padding-top: 4px; min-width: 220px; }
  .foot { padding: 8px 24px 14px; font-size: 10px; color: #94a3b8; display: flex; justify-content: space-between; }
  .warn { margin: 6px 24px; padding: 7px 10px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; font-size: 11px; border-radius: 6px; }
  @media print { body { padding: 0 } .slip { border: none } }
</style></head><body><div class="slip">
  <div class="head">
    <div class="brand">${e(vendor?.name || "Company")}<small>${e(vendor?.address || "Dhaka, Bangladesh")}${vendor?.phone ? ` · ${e(vendor.phone)}` : ""} · TIN/BIN: ${companyTin}</small></div>
    <div class="meta"><b>TDS Salary Tax Slip ${certNo}</b><br>Period: ${period}<br>${fyLabel}</div>
  </div>
  <div class="grid">
    <div class="cell"><b>Employee / কর্মী</b><br>${e(emp?.fullName || "")} (${e(emp?.code || "")})</div>
    <div class="cell"><b>Employee TIN</b><br>${emp?.tinNo ? e(emp.tinNo) : "—"}</div>
    <div class="cell"><b>Designation</b><br>${e(desig?.name || "—")}</div>
    <div class="cell"><b>Department</b><br>${e(dept?.name || "—")}</div>
    <div class="cell"><b>Branch</b><br>${e(branch?.name || "—")}</div>
    <div class="cell"><b>Date of Birth</b><br>${e(emp?.dob || "—")}</div>
  </div>
  <h4>Calculation Breakdown — ${secRef}</h4>
  <table>${rowHtml}</table>
  ${slabHtml}
  ${warns.length ? warns.map((w) => `<div class="warn">⚠ ${w}</div>`).join("") : ""}
  <div class="disc">
    <b>বাংলা:</b> ${e(AIT_DISCLAIMER_BN)}<br><br>
    <b>English:</b> ${e(AIT_DISCLAIMER_EN)}
  </div>
  <div class="sign">
    <div class="box"><div class="line">Employee Signature</div></div>
    <div class="box"><div class="line">Authorized Signatory — ${e(vendor?.signatoryName || vendor?.legalName || vendor?.name || "")}${vendor?.signatoryDesignation ? `, ${e(vendor.signatoryDesignation)}` : ""}</div></div>
  </div>
  <div class="foot"><span>Generated ${e(new Date().toISOString().slice(0, 10))} · Withholding reference ${secRef} · Income Tax Act 2023</span><span>This month's TDS: ${money(monthTds)}</span></div>
</div></body></html>`
}

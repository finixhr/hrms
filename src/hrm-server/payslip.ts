// ============ Payslip document builder (spec §9.7) ============
// Professional print-ready payslip HTML — shared by the HR view, ESS portal,
// and the payslip email delivery pipeline (one renderer, one layout).
//
// H-1 REMEDIATION: every interpolated value is HTML-escaped and every URL is
// attribute-quoted via escapeAttrUrl; the document ships a restrictive CSP
// meta (default-src 'none') and contains NO scripts at all — print is
// triggered by the opener. Stored-XSS through the print window is closed.
import { db } from "@/lib/db"
import { getSettings } from "./settings"
import { j, monthName } from "./utils"
import { escapeHtml, escapeAttrUrl } from "./security"
import { resolveSalaryPayout } from "./payout"

export async function getPayslipContext(vendorId: string, entryId: string) {
  const entry = await db.payrollEntry.findFirst({ where: { id: entryId, vendorId } })
  if (!entry || !entry.payslipNumber) return null
  const run = await db.payrollRun.findUnique({ where: { id: entry.runId } })
  const emp = await db.employee.findUnique({ where: { id: entry.employeeId } })
  const branch = emp?.branchId ? await db.branch.findFirst({ where: { id: emp.branchId } }) : null
  const dept = emp?.departmentId ? await db.department.findFirst({ where: { id: emp.departmentId } }) : null
  const desig = emp?.designationId ? await db.designation.findFirst({ where: { id: emp.designationId } }) : null
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } })
  // 2026-10 round §47 — NEVER findFirst() blindly for salary payment info:
  // resolve the employee's DESIGNATED salary payout account (exactly-one
  // semantics) instead of whichever bank row happened to be first.
  const payout = await resolveSalaryPayout(entry.employeeId)
  const bank = payout.account
    ? {
        ...payout.account,
        bankName: payout.account.bank,
        paymentMethod: payout.method,
        accountNumber: payout.account.accountNumber ?? payout.account.mfsNumber,
      }
    : null
  const settings = await getSettings(vendorId)
  const bd = j(entry.breakdownJson, {})
  return { entry, run, emp, branch, dept, desig, vendor, bank, settings, bd }
}

export function renderPayslipHtml(x: {
  entry: any; run: any; emp: any; branch: any; dept: any; desig: any; vendor: any
  bank: any; bd: any; logoUrl?: string | null
}): string {
  const bd = x.bd || {}
  const earnings: { label: string; amount: number }[] = bd.earnings || []
  const deductions: { label: string; amount: number }[] = bd.deductions || []
  const att = bd.attendance || {}
  const e = escapeHtml
  // 2026-10-14 — the printed Total Deductions must equal the SUM OF THE LISTED
  // LINES (the engine breakdown now carries guarantor recoveries, early-leave
  // tiers, PF and AIT as itemised lines). Legacy rows without a deductions
  // array (bulk-seeded history) keep the column-based formula, extended with
  // guarantorDeduction so guarantor-paid recoveries are never dropped.
  const deductionsTotal = deductions.length > 0
    ? deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0)
    : Number(x.entry.absenceDeduction + x.entry.lateDeduction + x.entry.loanDeduction + x.entry.advanceDeduction + x.entry.guarantorDeduction + x.entry.otherDeduction + x.entry.ait || 0)
  // H-1 — deduction labels are free-typed by payroll users: escape EVERYTHING
  const row = (l: string, a: number) => `<tr><td>${e(l)}</td><td style="text-align:right">৳${Number(a || 0).toLocaleString("en-IN")}</td></tr>`
  // 64px embed — prefer the 96×96 thumbnail (crisp at this size AND keeps
  // the generated payslip HTML light); fall back to photoUrl for photos
  // uploaded before thumbnails existed.
  const photoSrc = escapeAttrUrl(x.emp?.photoThumb) || escapeAttrUrl(x.emp?.photoUrl)
  const photo = photoSrc
    ? `<img src="${photoSrc}" alt="" style="width:64px;height:64px;border-radius:6px;object-fit:cover;border:1px solid #cbd5e1" />`
    : `<div style="width:64px;height:64px;border-radius:6px;background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:10px">PHOTO</div>`
  const logoUrl = escapeAttrUrl(x.logoUrl)
  const logo = logoUrl
    ? `<img src="${logoUrl}" alt="" style="height:44px;object-fit:contain" />`
    : ""
  const paymentMethod = x.bank?.paymentMethod ? e(String(x.bank.paymentMethod).replace(/_/g, " ")) : "—"
  const bankLine = x.bank?.accountNumber ? `${e(x.bank.bankName || "Bank")} · A/C ${e(String(x.bank.accountNumber).slice(-4).padStart(4, "•"))}` : "—"
  const warnings: string[] = Array.isArray(bd.warnings) ? bd.warnings : []
  return `<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${e(x.entry.payslipNumber)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'">
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 0; padding: 24px; background: #fff; }
  .slip { max-width: 720px; margin: 0 auto; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; }
  .head { display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; background: #f8fafc; border-bottom: 2px solid #059669; gap: 12px; }
  .brand { font-size: 20px; font-weight: 700; color: #065f46; display:flex; align-items:center; gap:10px; }
  .brand small { display: block; font-weight: 400; color: #64748b; font-size: 11px; }
  .psno { text-align: right; font-size: 12px; color: #475569; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border-bottom: 1px solid #e2e8f0; }
  .cell { padding: 8px 24px; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
  .cell b { color: #334155; }
  h4 { margin: 14px 24px 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #059669; }
  table { width: calc(100% - 48px); margin: 4px 24px 8px; border-collapse: collapse; font-size: 12px; }
  td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; }
  tr.total td { font-weight: 700; background: #f0fdf4; border-top: 2px solid #059669; }
  .net { display: flex; justify-content: space-between; padding: 12px 24px; background: #065f46; color: #fff; font-weight: 700; font-size: 14px; }
  .foot { padding: 10px 24px; font-size: 10px; color: #94a3b8; display:flex; justify-content:space-between }
  .warn { margin: 8px 24px; padding: 8px 10px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; font-size: 11px; border-radius: 6px; }
  @media print { body { padding: 0 } .slip { border: none } }
</style></head><body><div class="slip">
  <div class="head">
    <div class="brand">${logo}<span>${e(x.vendor?.name || "My Company Ltd.")}<small>${e(x.vendor?.address || "Dhaka, Bangladesh")} · ${e(x.vendor?.phone || "")}</small></span></div>
    <div class="psno"><b>Payslip ${e(x.entry.payslipNumber)}</b><br>Salary Month: ${x.run ? e(monthName(x.run.periodMonth) + " " + x.run.periodYear) : ""}<br>Payment: ${e(x.run?.paymentDate || "—")}</div>
  </div>
  <div class="grid">
    <div class="cell" style="display:flex;gap:12px;align-items:center">${photo}<div><b>Employee</b><br>${e(x.emp?.fullName || "")} (${e(x.emp?.code || "")})</div></div>
    <div class="cell"><b>Designation</b><br>${e(x.desig?.name || "—")}</div>
    <div class="cell"><b>Department</b><br>${e(x.dept?.name || "—")}</div>
    <div class="cell"><b>Branch</b><br>${e(x.branch?.name || "—")}</div>
    <div class="cell"><b>Joining Date</b><br>${e(x.emp?.joiningDate || "—")}</div>
    <div class="cell"><b>Attendance</b><br>Present ${e(att.presentDays ?? "—")}d · Absent ${e(att.absentDays ?? 0)}d · Leave ${e(att.leaveDays ?? 0)}d · OT ${e(Math.round((att.otMinutes || 0) / 60))}h</div>
    <div class="cell"><b>Payment Method</b><br>${paymentMethod}</div>
    <div class="cell"><b>Bank / MFS</b><br>${bankLine}</div>
  </div>
  ${bd.proration ? `<div class="cell" style="grid-column:1/-1;background:#f8fafc"><b>Weekly proration</b> — ${e(bd.proration.weekWorkingDays)} of ${e(bd.proration.monthWorkingDays)} working days (${e(Math.round(bd.proration.fraction * 100))}%)</div>` : ""}
  ${warnings.map((w) => `<div class="warn">${e(w)}</div>`).join("")}
  <h4>Earnings</h4>
  <table>${earnings.map((x2) => row(x2.label, x2.amount)).join("")}
    <tr><td>Overtime</td><td style="text-align:right">৳${Number(x.entry.otAmount || 0).toLocaleString("en-IN")}</td></tr>
    <tr><td>Bonus</td><td style="text-align:right">৳${Number(x.entry.bonus || 0).toLocaleString("en-IN")}</td></tr>
    <tr><td>Commission</td><td style="text-align:right">৳${Number(x.entry.commission || 0).toLocaleString("en-IN")}</td></tr>
    <tr class="total"><td>Gross Earnings</td><td style="text-align:right">৳${Number(x.entry.gross + x.entry.otAmount + x.entry.bonus + x.entry.commission || 0).toLocaleString("en-IN")}</td></tr>
  </table>
  <h4>Deductions</h4>
  <table>${deductions.map((d) => row(d.label, d.amount)).join("") || row("—", 0)}
    <tr class="total"><td>Total Deductions (incl. AIT)</td><td style="text-align:right">৳${deductionsTotal.toLocaleString("en-IN")}</td></tr>
  </table>
  <div class="net"><span>NET SALARY PAYABLE</span><span>৳${Number(x.entry.net || 0).toLocaleString("en-IN")}</span></div>
  <div class="foot"><span>Generated by Finix HR</span><span>This is a computer-generated document.</span></div>
</div>
</body></html>`
}

/** Full pipeline: load context → render HTML for one payslip. */
export async function buildPayslipHtml(vendorId: string, entryId: string): Promise<string | null> {
  const ctx = await getPayslipContext(vendorId, entryId)
  if (!ctx) return null
  return renderPayslipHtml({ ...ctx, logoUrl: ctx.settings.general.logoUrl || ctx.vendor?.logoUrl || null })
}

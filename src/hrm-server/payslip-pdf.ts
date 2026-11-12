// ============ Payslip PDF renderer (UXD-3, P2 wave 2026-11-09) ============
// Serves payslips as a real PDF download that works on mobile (popup blockers
// killed the openHtmlWindow/document.write flow), mirroring the billing
// invoice PDF pipeline: pdf-lib + the shared corporate header/footer.
//
// WinAnsi constraint (pdf-lib StandardFonts): the taka sign and Bangla text
// cannot ride this path — currency prints as "BDT" (same discipline as
// invoice/receipt/mushak PDFs; the HTML payslip keeps the ৳ glyph).
import { PDFDocument, rgb, StandardFonts } from "pdf-lib"
import { winAnsi, fit, drawFinixHeader, drawFinixFooter, tryEmbedImage } from "./saas/payments/pdf-common"
import { monthName } from "./utils"

const INK = rgb(0.09, 0.11, 0.16)
const MUTED = rgb(0.45, 0.5, 0.58)
const EMERALD = rgb(0.02, 0.56, 0.42)
const LINE = rgb(0.85, 0.88, 0.92)
const BAND = rgb(0.965, 0.98, 0.972)

const money = (n: number | null | undefined) =>
  `BDT ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Render one payslip as a PDF buffer. `ctx` is exactly what
 *  getPayslipContext(vendorId, entryId) returns (see payslip.ts). */
export async function renderPayslipPdf(ctx: {
  entry: any; run: any; emp: any; branch: any; dept: any; desig: any; vendor: any
  bank: any; bd: any; logoUrl?: string | null
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Payslip ${ctx.entry.payslipNumber}`)
  const page = doc.addPage([595.28, 841.89]) // A4 portrait
  const pageW = page.getWidth()
  const pageH = page.getHeight()
  const marginX = 42
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique)

  const bd = ctx.bd || {}
  const earnings: { label: string; amount: number }[] = bd.earnings || []
  const deductions: { label: string; amount: number }[] = bd.deductions || []
  const att = bd.attendance || {}

  // ---- corporate header (logo + platform identity, same as invoices) ----
  let y = await drawFinixHeader({
    doc, page, pageW, pageH, marginX,
    data: {
      platformName: ctx.vendor?.name || "Finix HR",
      companyAddress: winAnsi(ctx.vendor?.address || ""),
      websiteUrl: undefined,
      logoUrl: ctx.logoUrl || undefined,
    },
    boldFont: bold,
    regularFont: font,
  })

  // ---- payslip identity band ----
  page.drawRectangle({ x: marginX, y: y - 46, width: pageW - marginX * 2, height: 40, color: BAND })
  page.drawText(winAnsi(`PAYSLIP  ${ctx.entry.payslipNumber}`), { x: marginX + 10, y: y - 20, size: 13, font: bold, color: EMERALD })
  const month = ctx.run ? `${monthName(ctx.run.periodMonth)} ${ctx.run.periodYear}` : "—"
  page.drawText(winAnsi(`Salary Month: ${month}   ·   Payment: ${ctx.run?.paymentDate || "—"}`), {
    x: marginX + 10, y: y - 36, size: 8.5, font, color: MUTED,
  })
  y -= 62

  // ---- employee facts grid (two columns of label/value lines) ----
  const facts: [string, string][] = [
    ["Employee", `${ctx.emp?.fullName || ""} (${ctx.emp?.code || ""})`],
    ["Designation", ctx.desig?.name || "—"],
    ["Department", ctx.dept?.name || "—"],
    ["Branch", ctx.branch?.name || "—"],
    ["Joining Date", ctx.emp?.joiningDate || "—"],
    ["Payment Method", ctx.bank?.paymentMethod || "—"],
    ["Bank / MFS", ctx.bank ? `${ctx.bank.bankName || ""} ${ctx.bank.accountNumber ? `· ${ctx.bank.accountNumber}` : ""}` : "—"],
    ["Attendance", `Present ${att.presentDays ?? "—"}d · Absent ${att.absentDays ?? 0}d · Leave ${att.leaveDays ?? 0}d · OT ${Math.round((att.otMinutes || 0) / 60)}h`],
  ]
  const colW = (pageW - marginX * 2) / 2 - 8
  facts.forEach(([label, value], i) => {
    const col = i % 2
    const row = Math.floor(i / 2)
    const x = marginX + col * (colW + 16)
    const yy = y - row * 30
    page.drawText(winAnsi(fit(label, colW, bold, 7.5)), { x, y: yy, size: 7.5, font: bold, color: MUTED })
    page.drawText(winAnsi(fit(String(value), colW, font, 9.5)), { x, y: yy - 12, size: 9.5, font, color: INK })
  })
  y -= Math.ceil(facts.length / 2) * 30 + 14

  // ---- money tables ----
  const drawMoneyTable = (title: string, rows: { label: string; amount: number }[], extra: { label: string; amount: number }[], totalLabel: string, total: number) => {
    page.drawText(winAnsi(title), { x: marginX, y, size: 10, font: bold, color: INK })
    y -= 16
    const all = [...rows, ...extra]
    for (const r of all) {
      page.drawText(winAnsi(fit(r.label || "—", colW * 2, font, 9)), { x: marginX + 4, y, size: 9, font, color: INK })
      page.drawText(winAnsi(money(r.amount)), { x: pageW - marginX - 4 - font.widthOfTextAtSize(money(r.amount), 9), y, size: 9, font, color: INK })
      y -= 14
    }
    page.drawLine({ start: { x: marginX, y: y + 6 }, end: { x: pageW - marginX, y: y + 6 }, thickness: 0.7, color: LINE })
    page.drawText(winAnsi(totalLabel), { x: marginX + 4, y, size: 9.5, font: bold, color: INK })
    const totalStr = money(total)
    page.drawText(winAnsi(totalStr), { x: pageW - marginX - 4 - bold.widthOfTextAtSize(totalStr, 9.5), y, size: 9.5, font: bold, color: INK })
    y -= 26
  }

  const otBonusCommission = [
    { label: "Overtime", amount: Number(ctx.entry.otAmount || 0) },
    { label: "Bonus", amount: Number(ctx.entry.bonus || 0) },
    { label: "Commission", amount: Number(ctx.entry.commission || 0) },
  ]
  const grossTotal = Number(ctx.entry.gross || 0) + Number(ctx.entry.otAmount || 0) + Number(ctx.entry.bonus || 0) + Number(ctx.entry.commission || 0)
  drawMoneyTable("Earnings", earnings, otBonusCommission, "Gross Earnings", grossTotal)

  const deductionsTotal = deductions.reduce((s, d) => s + Number(d.amount || 0), 0) + Number(ctx.entry.ait || 0)
  drawMoneyTable("Deductions", deductions, [{ label: "AIT", amount: Number(ctx.entry.ait || 0) }], "Total Deductions (incl. AIT)", deductionsTotal)

  // ---- net pay band ----
  page.drawRectangle({ x: marginX, y: y - 26, width: pageW - marginX * 2, height: 34, color: EMERALD })
  page.drawText("NET SALARY PAYABLE", { x: marginX + 12, y: y - 15, size: 11, font: bold, color: rgb(1, 1, 1) })
  const netStr = money(ctx.entry.net)
  page.drawText(winAnsi(netStr), { x: pageW - marginX - 12 - bold.widthOfTextAtSize(netStr, 12), y: y - 16, size: 12, font: bold, color: rgb(1, 1, 1) })
  y -= 44

  // ---- footer ----
  drawFinixFooter({
    page, pageW, marginX,
    platformName: ctx.vendor?.name || "Finix HR",
    websiteUrl: undefined,
    italicFont: oblique,
    regularFont: font,
    pageNumberText: "Computer Generated Payslip",
  })

  return doc.save()
}

/** Try to embed the logo when one is configured (best effort — a broken or
 *  exotic image format must never fail the payslip). */
export async function embedPayslipLogo(doc: PDFDocument, logoUrl?: string | null) {
  if (!logoUrl) return null
  try { return await tryEmbedImage(doc, logoUrl) } catch { return null }
}

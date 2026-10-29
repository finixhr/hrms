// ============ Money Receipt PDF Generator ============
// Generates an official, standard "Tenant Payment Money Receipt" (A4 portrait)
// matching the Finix HR corporate finance design specifications.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import QRCode from "qrcode"
import {
  winAnsi, fit, fmtDate, fmtDateTime,
  tryEmbedImage, drawFinixHeader, drawFinixFooter,
} from "./pdf-common"

export type ReceiptPdfData = {
  platformName: string
  tagline?: string
  websiteUrl: string
  supportEmail: string
  companyAddress: string
  contactPhone?: string
  logoUrl?: string
  sealUrl?: string
  signatureUrl?: string
  signatoryName?: string
  signatoryDesignation?: string
  receiptNumber: string
  invoiceNumber: string
  paidAt: Date | null
  tenantName: string
  tenantCode: string
  planName: string
  maxEmployees: number | string
  billingCycle: string
  periodStart: Date
  periodEnd: Date
  method: string
  transactionId: string
  paidBy: string
  amount: number
  currency: string
  vatRatePercent: number
  netAmount: number
  vatAmount: number
}

export async function renderReceiptPdf(data: ReceiptPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique)
  const boldOblique = await doc.embedFont(StandardFonts.HelveticaBoldOblique)

  const pageW = 595.28 // A4 portrait
  const pageH = 841.89
  const marginX = 36
  const tableW = pageW - marginX * 2

  const page = doc.addPage([pageW, pageH])

  // Palette matching corporate mockup
  const primaryBlue = rgb(0.145, 0.388, 0.92) // #2563eb
  const darkNavy = rgb(0.09, 0.13, 0.33)    // #172254
  const slateDark = rgb(0.09, 0.12, 0.18)   // #1e293b
  const slateMuted = rgb(0.39, 0.45, 0.55)  // #64748b
  const slateLight = rgb(0.94, 0.96, 0.98)  // #f1f5f9
  const borderBlue = rgb(0.75, 0.86, 0.99)  // #bfdbfe
  const bgBlueCard = rgb(0.94, 0.97, 1.0)   // #f0f7ff
  const greenPaid = rgb(0.08, 0.64, 0.29)   // #16a34a
  const greenBg = rgb(0.94, 0.99, 0.96)     // #f0fdf4
  const greenBorder = rgb(0.52, 0.94, 0.67) // #86efac
  const greenText = rgb(0.08, 0.5, 0.24)    // #15803d
  const white = rgb(1, 1, 1)

  // =========================================================================
  // 1. TOP HEADER (Shared Finix HR Header with Vector Icons)
  // =========================================================================
  let y = await drawFinixHeader({
    doc,
    page,
    pageW,
    pageH,
    marginX,
    data: {
      platformName: data.platformName,
      tagline: data.tagline,
      websiteUrl: data.websiteUrl,
      supportEmail: data.supportEmail,
      companyAddress: data.companyAddress,
      logoUrl: data.logoUrl,
    },
    boldFont: bold,
    regularFont: font,
  })

  // =========================================================================
  // 2. RECEIPT TITLE & PAID BADGE SECTION
  // =========================================================================
  page.drawText("Tenant Payment Money Receipt", { x: marginX, y, size: 16, font: bold, color: darkNavy })
  page.drawText("This is to acknowledge receipt of your payment for Finix HR subscription.", {
    x: marginX,
    y: y - 13,
    size: 8,
    font,
    color: slateMuted,
  })

  // Right side: PAID Pill Badge
  const badgeW = 58
  const badgeH = 17
  const badgeX = pageW - marginX - badgeW
  page.drawRectangle({
    x: badgeX,
    y: y - 2,
    width: badgeW,
    height: badgeH,
    color: greenPaid,
  })
  page.drawText("PAID", { x: badgeX + 16, y: y + 2, size: 9, font: bold, color: white })

  // Receipt Number & Date under badge
  const recNo = winAnsi(data.receiptNumber || `MR-${data.invoiceNumber.replace(/^INV-/, "")}`)
  page.drawText(`Receipt No:  ${recNo}`, { x: pageW - marginX - 165, y: y - 18, size: 8.5, font: bold, color: slateDark })
  page.drawText(`Date:  ${fmtDateTime(data.paidAt)}`, { x: pageW - marginX - 165, y: y - 30, size: 8, font, color: slateMuted })

  y -= 44

  // =========================================================================
  // 3. TWO SIDE-BY-SIDE INFORMATION CARDS
  // =========================================================================
  const cardGap = 12
  const cardW = (tableW - cardGap) / 2
  const cardH = 112

  // Card 1: Tenant Information (Left)
  page.drawRectangle({
    x: marginX,
    y: y - cardH,
    width: cardW,
    height: cardH,
    color: bgBlueCard,
    borderColor: borderBlue,
    borderWidth: 0.8,
  })

  page.drawText("Tenant Information", { x: marginX + 12, y: y - 18, size: 9.5, font: bold, color: primaryBlue })

  let card1RowY = y - 33
  const drawCard1Row = (label: string, val: string) => {
    page.drawText(label, { x: marginX + 12, y: card1RowY, size: 8, font, color: slateMuted })
    page.drawText(":", { x: marginX + 96, y: card1RowY, size: 8, font, color: slateMuted })
    page.drawText(fit(val, cardW - 110, bold, 8), { x: marginX + 104, y: card1RowY, size: 8, font: bold, color: slateDark })
    card1RowY -= 13
  }

  drawCard1Row("Tenant Name", data.tenantName || "Client")
  drawCard1Row("Tenant ID", data.tenantCode || "TEN-000000")
  drawCard1Row("Plan", data.planName || "Business")
  drawCard1Row("Employee Limit", String(data.maxEmployees || 250))
  drawCard1Row("Billing Cycle", String(data.billingCycle || "Monthly").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()))
  drawCard1Row("Subscription Period", `${fmtDate(data.periodStart)} - ${fmtDate(data.periodEnd)}`)

  // Card 2: Payment Information (Right)
  const card2X = marginX + cardW + cardGap
  page.drawRectangle({
    x: card2X,
    y: y - cardH,
    width: cardW,
    height: cardH,
    color: bgBlueCard,
    borderColor: borderBlue,
    borderWidth: 0.8,
  })

  page.drawText("Payment Information", { x: card2X + 12, y: y - 18, size: 9.5, font: bold, color: primaryBlue })

  let card2RowY = y - 33
  const drawCard2Row = (label: string, val: string) => {
    page.drawText(label, { x: card2X + 12, y: card2RowY, size: 8, font, color: slateMuted })
    page.drawText(":", { x: card2X + 92, y: card2RowY, size: 8, font, color: slateMuted })
    page.drawText(fit(val, cardW - 106, bold, 8), { x: card2X + 100, y: card2RowY, size: 8, font: bold, color: slateDark })
    card2RowY -= 13
  }

  drawCard2Row("Payment Method", data.method || "Bank Transfer")
  drawCard2Row("Transaction ID", data.transactionId || "—")
  drawCard2Row("Payment Date", fmtDateTime(data.paidAt))
  drawCard2Row("Paid By", data.paidBy || "Finance Department")

  y -= (cardH + 18)

  // =========================================================================
  // 4. PAYMENT BREAKDOWN TABLE
  // =========================================================================
  page.drawText("Payment Breakdown", { x: marginX, y, size: 10, font: bold, color: darkNavy })
  y -= 14

  const colDescW = tableW - 220
  const colPeriodW = 120
  const colAmtW = 100

  // Table Header (Royal Blue Fill)
  const tblHeaderH = 20
  page.drawRectangle({
    x: marginX,
    y: y - tblHeaderH,
    width: tableW,
    height: tblHeaderH,
    color: primaryBlue,
  })
  page.drawText("Description", { x: marginX + 12, y: y - 14, size: 8.5, font: bold, color: white })
  page.drawText("Period", { x: marginX + colDescW + 12, y: y - 14, size: 8.5, font: bold, color: white })
  page.drawText("Amount (BDT)", { x: marginX + colDescW + colPeriodW + 20, y: y - 14, size: 8.5, font: bold, color: white })

  y -= tblHeaderH

  // Row 1: Plan Subscription
  const row1H = 24
  page.drawRectangle({
    x: marginX,
    y: y - row1H,
    width: tableW,
    height: row1H,
    color: white,
    borderColor: rgb(0.85, 0.9, 0.95),
    borderWidth: 0.6,
  })
  page.drawText(`Finix HR Subscription (${data.planName} Plan)`, { x: marginX + 12, y: y - 15, size: 8, font: bold, color: slateDark })
  page.drawText(`${fmtDate(data.periodStart)} - ${fmtDate(data.periodEnd)}`, { x: marginX + colDescW + 12, y: y - 15, size: 8, font, color: slateMuted })
  const netAmount = Number(data.netAmount) > 0 ? Number(data.netAmount) : Number(data.amount)
  page.drawText(`Tk ${netAmount.toFixed(2)}`, { x: marginX + colDescW + colPeriodW + 25, y: y - 15, size: 8.5, font: bold, color: slateDark })

  y -= row1H

  // Row 2: VAT Line Item (if VAT exists)
  const vatAmount = Number(data.vatAmount) > 0 ? Number(data.vatAmount) : 0
  if (vatAmount > 0) {
    const rowVatH = 22
    page.drawRectangle({
      x: marginX,
      y: y - rowVatH,
      width: tableW,
      height: rowVatH,
      color: slateLight,
      borderColor: rgb(0.85, 0.9, 0.95),
      borderWidth: 0.6,
    })
    page.drawText(`VAT (${data.vatRatePercent || 5}% inclusive)`, { x: marginX + 12, y: y - 14, size: 8, font, color: slateMuted })
    page.drawText("-", { x: marginX + colDescW + 40, y: y - 14, size: 8, font, color: slateMuted })
    page.drawText(`Tk ${vatAmount.toFixed(2)}`, { x: marginX + colDescW + colPeriodW + 25, y: y - 14, size: 8, font, color: slateDark })
    y -= rowVatH
  }

  // Footer Row: Total Paid
  const totalRowH = 26
  page.drawRectangle({
    x: marginX,
    y: y - totalRowH,
    width: tableW,
    height: totalRowH,
    color: rgb(0.9, 0.95, 1.0),
    borderColor: rgb(0.7, 0.85, 0.98),
    borderWidth: 0.8,
  })
  page.drawText("Total Paid", { x: marginX + colDescW + 30, y: y - 17, size: 9.5, font: bold, color: slateDark })
  page.drawText(`Tk ${Number(data.amount).toFixed(2)}`, { x: marginX + colDescW + colPeriodW + 15, y: y - 17, size: 11, font: bold, color: primaryBlue })

  y -= (totalRowH + 18)

  // =========================================================================
  // 5. TWO BOTTOM CARDS (Payment Received & Important Notes)
  // =========================================================================
  const noteBoxH = 68
  const noteBoxW = (tableW - cardGap) / 2

  // Left Box: Payment Received (Green)
  page.drawRectangle({
    x: marginX,
    y: y - noteBoxH,
    width: noteBoxW,
    height: noteBoxH,
    color: greenBg,
    borderColor: greenBorder,
    borderWidth: 0.8,
  })
  page.drawText("Payment Received", { x: marginX + 12, y: y - 18, size: 9, font: bold, color: greenText })
  page.drawText("Thank you for choosing Finix HR.", { x: marginX + 12, y: y - 32, size: 7.5, font, color: greenText })
  page.drawText("Your payment has been successfully received and", { x: marginX + 12, y: y - 44, size: 7.5, font, color: greenText })
  page.drawText("your subscription is now active.", { x: marginX + 12, y: y - 56, size: 7.5, font, color: greenText })

  // Right Box: Important Notes (Blue)
  const noteRightX = marginX + noteBoxW + cardGap
  page.drawRectangle({
    x: noteRightX,
    y: y - noteBoxH,
    width: noteBoxW,
    height: noteBoxH,
    color: bgBlueCard,
    borderColor: borderBlue,
    borderWidth: 0.8,
  })
  page.drawText("Important Notes", { x: noteRightX + 12, y: y - 18, size: 9, font: bold, color: primaryBlue })
  page.drawText("- This receipt is computer generated and does not require a signature.", { x: noteRightX + 12, y: y - 32, size: 7.2, font, color: slateMuted })
  page.drawText("- Keep this receipt for your records.", { x: noteRightX + 12, y: y - 44, size: 7.2, font, color: slateMuted })
  page.drawText("- For any queries, please contact our support team.", { x: noteRightX + 12, y: y - 56, size: 7.2, font, color: slateMuted })

  y -= (noteBoxH + 20)

  // =========================================================================
  // 6. VERIFICATION, STAMP & AUTHORIZED SIGNATURE
  // =========================================================================
  // Left: QR Code
  try {
    const qrPayload = `FinixHR:MoneyReceipt:No=${recNo}:Tenant=${data.tenantName}:Amount=${data.amount}:Date=${fmtDate(data.paidAt)}`
    const qrBuffer = await QRCode.toBuffer(qrPayload, { width: 80, margin: 1 })
    const qrImg = await doc.embedPng(qrBuffer)
    page.drawImage(qrImg, { x: marginX, y: y - 62, width: 62, height: 62 })
  } catch {
    page.drawRectangle({ x: marginX, y: y - 62, width: 62, height: 62, color: slateLight, borderColor: borderBlue, borderWidth: 0.5 })
  }
  page.drawText("Scan to verify", { x: marginX + 70, y: y - 26, size: 7.5, font: bold, color: slateDark })
  page.drawText("this receipt", { x: marginX + 70, y: y - 36, size: 7.5, font: bold, color: slateDark })
  page.drawText("(Optional)", { x: marginX + 70, y: y - 48, size: 7, font, color: slateMuted })

  // Center: Circular PAID Stamp (or custom uploaded seal)
  const stampCenterX = pageW / 2
  const stampCenterY = y - 32
  const customSeal = await tryEmbedImage(doc, data.sealUrl)
  if (customSeal) {
    const scale = Math.min(64 / customSeal.height, 64 / customSeal.width, 1)
    const sw = customSeal.width * scale
    const sh = customSeal.height * scale
    page.drawImage(customSeal.img, { x: stampCenterX - sw / 2, y: stampCenterY - sh / 2, width: sw, height: sh })
  } else {
    // Official circular Finix HR Paid Seal
    page.drawCircle({ x: stampCenterX, y: stampCenterY, size: 34, borderColor: primaryBlue, borderWidth: 1.5 })
    page.drawCircle({ x: stampCenterX, y: stampCenterY, size: 28, borderColor: primaryBlue, borderWidth: 0.8 })
    page.drawText("FINIX HR", { x: stampCenterX - 20, y: stampCenterY + 16, size: 7.5, font: bold, color: primaryBlue })
    page.drawText("*  PAID  *", { x: stampCenterX - 20, y: stampCenterY - 22, size: 7.5, font: bold, color: primaryBlue })
    page.drawText("F", { x: stampCenterX - 6, y: stampCenterY - 6, size: 16, font: bold, color: primaryBlue })
  }

  // Right: Authorized Signature (custom uploaded signature or script simulation)
  const sigX = pageW - marginX - 140
  const sigY = y - 48
  const customSig = await tryEmbedImage(doc, data.signatureUrl)
  if (customSig) {
    const scale = Math.min(32 / customSig.height, 120 / customSig.width, 1)
    const sw = customSig.width * scale
    const sh = customSig.height * scale
    page.drawImage(customSig.img, { x: sigX + (130 - sw) / 2, y: sigY + 14, width: sw, height: sh })
  } else {
    const sigName = winAnsi(data.signatoryName || "MD JAKARIA")
    page.drawText(sigName, { x: sigX + 16, y: sigY + 20, size: 13, font: boldOblique, color: darkNavy })
  }
  page.drawLine({
    start: { x: sigX, y: sigY + 12 },
    end: { x: sigX + 130, y: sigY + 12 },
    thickness: 0.8,
    color: slateMuted,
  })
  page.drawText("Authorized Signature", { x: sigX + 16, y: sigY + 2, size: 8, font: bold, color: slateDark })
  page.drawText(fit(data.signatoryDesignation || data.platformName || "Finix HR Ltd.", 130, font, 7.5), {
    x: sigX + 10,
    y: sigY - 8,
    size: 7.5,
    font,
    color: slateMuted,
  })

  // =========================================================================
  // 7. BOTTOM BASELINE FOOTER (Shared Finix HR Footer)
  // =========================================================================
  drawFinixFooter({
    page,
    pageW,
    marginX,
    platformName: data.platformName,
    websiteUrl: data.websiteUrl,
    italicFont: oblique,
    regularFont: font,
  })

  return doc.save()
}

// ============ Standard 1-Page Tax Invoice PDF Generator ============
// Generates an official, standard 1-page Bangladesh tax invoice (A4 portrait)
// with unified Finix HR corporate header, footer, two side-by-side payment boxes
// (Left: Bank 1 & Bank 2; Right: MFS/Bangla QR/bKash/Nagad with QR code).
import { PDFDocument, rgb, StandardFonts } from "pdf-lib"
import QRCode from "qrcode"
import {
  winAnsi, fit, fmtDate,
  drawFinixHeader, drawFinixFooter, tryEmbedImage,
} from "./pdf-common"

export type InvoicePdfData = {
  platformName: string
  tagline?: string
  websiteUrl?: string
  supportEmail?: string
  logoUrl?: string
  invoiceNumber: string
  issuedAt: Date
  dueAt: Date | null
  status: string // PENDING | PAID | FAILED | CANCELLED
  companyLegalName: string
  companyBin: string
  companyAddress: string
  companyPhone: string
  companyEmail: string
  companyWebsite: string
  customerName: string
  customerAddress?: string | null
  customerPhone?: string | null
  customerEmail?: string | null
  planName: string
  billingCycle: string
  periodStart: Date
  periodEnd: Date
  amount: number
  currency: string
  vatRatePercent: number
  transactions?: {
    date: Date
    gateway: string
    transactionId: string
    amount: number
  }[]
  primaryBank: {
    bankName: string
    accountNo: string
    payeeName: string
    branch: string
    routing: string
  }
  secondaryBank: {
    bankName: string
    accountNo: string
    payeeName: string
    branch: string
    routing: string
  }
  mfs?: {
    providerName?: string
    merchantNumber?: string
    qrUrl?: string
    instructions?: string
  }
  bkash?: {
    merchantNumber: string
  }
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique)

  const pageW = 595.28 // A4 portrait in points
  const pageH = 841.89
  const marginX = 36
  const tableW = pageW - marginX * 2

  const total = Number(data.amount) || 0
  const vatRate = Number(data.vatRatePercent) || 0
  const net = vatRate > 0 ? Math.round((total / (1 + vatRate / 100)) * 100) / 100 : total
  const vat = Math.round((total - net) * 100) / 100
  const isPaid = data.status === "PAID"
  const paid = isPaid ? total : 0
  const due = total - paid

  // Corporate palette matching Money Receipt
  const primaryBlue = rgb(0.145, 0.388, 0.92) // #2563eb
  const darkNavy = rgb(0.09, 0.13, 0.33)    // #172254
  const lightGray = rgb(0.96, 0.97, 0.98)
  const borderGray = rgb(0.85, 0.88, 0.92)
  const textDark = rgb(0.09, 0.12, 0.18)   // #1e293b
  const textMuted = rgb(0.39, 0.45, 0.55)  // #64748b
  const white = rgb(1, 1, 1)
  const redStatus = rgb(0.85, 0.15, 0.15)
  const greenStatus = rgb(0.08, 0.64, 0.29)
  const bgBlueCard = rgb(0.94, 0.97, 1.0)
  const borderBlue = rgb(0.75, 0.86, 0.99)
  const mfsRose = rgb(0.85, 0.12, 0.38)    // #d91d60

  const headerContact = {
    platformName: data.platformName || "Finix HR",
    tagline: data.tagline || "Standalone HRM & Workforce Platform",
    websiteUrl: data.websiteUrl || (data.companyWebsite ? (data.companyWebsite.startsWith("http") ? data.companyWebsite : `https://${data.companyWebsite}`) : "https://hrm.finixmart.com.bd"),
    supportEmail: data.supportEmail || data.companyEmail || "support@finixhr.com",
    companyAddress: data.companyAddress || "Dhaka, Bangladesh",
    logoUrl: data.logoUrl,
  }

  // =========================================================================
  // SINGLE PAGE A4 INVOICE
  // =========================================================================
  const page = doc.addPage([pageW, pageH])

  // Shared Finix HR Header
  let y = await drawFinixHeader({
    doc,
    page,
    pageW,
    pageH,
    marginX,
    data: headerContact,
    boldFont: bold,
    regularFont: font,
  })

  // 1. Invoice # and Mushak-6.3 Tax Invoice Header
  page.drawText(`Tax Invoice # ${data.invoiceNumber}`, { x: marginX, y, size: 14, font: bold, color: darkNavy })
  page.drawText("Mushak-6.3 Tax Invoice", { x: pageW - marginX - 150, y, size: 10.5, font: bold, color: darkNavy })
  y -= 14

  page.drawText(`Date Issued: ${fmtDate(data.issuedAt)}`, { x: marginX, y, size: 8, font, color: textMuted })
  page.drawText(fit(data.companyLegalName, 180, font, 8), { x: pageW - marginX - 150, y, size: 8, font, color: textMuted })
  y -= 12

  page.drawText(`Due Date: ${fmtDate(data.dueAt)}`, { x: marginX, y, size: 8, font, color: textMuted })
  page.drawText(`BIN: ${data.companyBin || "-"}`, { x: pageW - marginX - 150, y, size: 8, font: bold, color: textDark })
  y -= 18

  // 2. INVOICE TO & PAYMENT DETAILS (Two Cards)
  const cardGap = 12
  const colW = (tableW - cardGap) / 2
  const cardH = 68

  // Left Card: INVOICE TO
  page.drawRectangle({
    x: marginX,
    y: y - cardH,
    width: colW,
    height: cardH,
    color: bgBlueCard,
    borderColor: borderBlue,
    borderWidth: 0.8,
  })
  page.drawText("INVOICE TO:", { x: marginX + 10, y: y - 14, size: 8, font: bold, color: primaryBlue })
  page.drawText(fit(data.customerName, colW - 20, bold, 9), { x: marginX + 10, y: y - 27, size: 9, font: bold, color: textDark })
  const addr = data.customerAddress || "Dhaka, Bangladesh"
  page.drawText(fit(addr, colW - 20, font, 7.5), { x: marginX + 10, y: y - 39, size: 7.5, font, color: textMuted })
  const contact = [data.customerPhone, data.customerEmail].filter(Boolean).join(", ")
  page.drawText(fit(contact || "Bangladesh", colW - 20, font, 7.5), { x: marginX + 10, y: y - 51, size: 7.5, font, color: textMuted })

  // Right Card: PAYMENT DETAILS
  const rightCardX = marginX + colW + cardGap
  page.drawRectangle({
    x: rightCardX,
    y: y - cardH,
    width: colW,
    height: cardH,
    color: bgBlueCard,
    borderColor: borderBlue,
    borderWidth: 0.8,
  })
  page.drawText("PAYMENT DETAILS:", { x: rightCardX + 10, y: y - 14, size: 8, font: bold, color: primaryBlue })
  page.drawText(`Invoice Amount:  Tk ${total.toFixed(2)}`, { x: rightCardX + 10, y: y - 27, size: 8, font, color: textDark })
  page.drawText(`Paid Amount:       Tk ${paid.toFixed(2)}`, { x: rightCardX + 10, y: y - 39, size: 8, font, color: textDark })
  page.drawText(`Total Due:            Tk ${due.toFixed(2)}`, { x: rightCardX + 10, y: y - 51, size: 8, font: bold, color: textDark })

  // Status Badge inside Right Card
  const statusColor = isPaid ? greenStatus : redStatus
  const statusLabel = isPaid ? "PAID" : "UNPAID"
  page.drawRectangle({ x: rightCardX + colW - 64, y: y - 24, width: 54, height: 15, color: statusColor })
  page.drawText(statusLabel, { x: rightCardX + colW - (isPaid ? 51 : 58), y: y - 20, size: 8, font: bold, color: white })

  y -= (cardH + 12)

  // 3. Line items table
  const colDesc = tableW - 190
  const colQty = 35
  const colUnit = 75

  // Table header (Royal Blue header)
  const tblHeaderH = 17
  page.drawRectangle({ x: marginX, y: y - tblHeaderH, width: tableW, height: tblHeaderH, color: primaryBlue })
  page.drawText("Description", { x: marginX + 8, y: y - 12, size: 8, font: bold, color: white })
  page.drawText("Qty", { x: marginX + colDesc + 8, y: y - 12, size: 8, font: bold, color: white })
  page.drawText("Unit Price", { x: marginX + colDesc + colQty + 8, y: y - 12, size: 8, font: bold, color: white })
  page.drawText("Total (BDT)", { x: marginX + colDesc + colQty + colUnit + 12, y: y - 12, size: 8, font: bold, color: white })

  y -= tblHeaderH

  // Table body row
  const rowH = 46
  page.drawRectangle({ x: marginX, y: y - rowH, width: tableW, height: rowH, borderColor: borderGray, borderWidth: 0.6 })
  let rowTextY = y - 12
  page.drawText(`Finix HR - ${data.planName} Plan (${data.billingCycle.toLowerCase()} cycle)`, { x: marginX + 8, y: rowTextY, size: 8.5, font: bold, color: textDark })
  rowTextY -= 11
  page.drawText(`Subscription Period: ${fmtDate(data.periodStart)} - ${fmtDate(data.periodEnd)}`, { x: marginX + 8, y: rowTextY, size: 7.5, font, color: textMuted })
  rowTextY -= 10
  page.drawText("Specification: Cloud HRM, Payroll, Attendance & Workforce Management", { x: marginX + 8, y: rowTextY, size: 7.5, font, color: textMuted })

  // Qty, Unit, Total
  page.drawText("1.00", { x: marginX + colDesc + 10, y: y - 14, size: 8, font, color: textDark })
  page.drawText(`Tk ${net.toFixed(2)}`, { x: marginX + colDesc + colQty + 8, y: y - 14, size: 8, font, color: textDark })
  page.drawText(`Tk ${net.toFixed(2)}`, { x: marginX + colDesc + colQty + colUnit + 10, y: y - 14, size: 8, font, color: textDark })

  y -= rowH

  // 4. Totals summary section & Recent Transactions
  const totalsBoxW = 190
  const totalsBoxX = pageW - marginX - totalsBoxW
  const drawTotalLine = (label: string, val: string, isTotalDue = false) => {
    page.drawRectangle({
      x: totalsBoxX,
      y: y - 14,
      width: totalsBoxW,
      height: 14,
      color: isTotalDue ? rgb(0.9, 0.95, 1.0) : (label.startsWith("VAT") ? lightGray : white),
      borderColor: isTotalDue ? borderBlue : borderGray,
      borderWidth: 0.5,
    })
    page.drawText(label, { x: totalsBoxX + 8, y: y - 10, size: 7.5, font: isTotalDue ? bold : font, color: isTotalDue ? primaryBlue : textDark })
    page.drawText(val, { x: totalsBoxX + totalsBoxW - 68, y: y - 10, size: 7.5, font: isTotalDue ? bold : font, color: isTotalDue ? primaryBlue : textDark })
    y -= 14
  }

  // Left area: Transactions Note / Log
  const txnBoxW = tableW - totalsBoxW - 12
  page.drawRectangle({
    x: marginX,
    y: y - 56,
    width: txnBoxW,
    height: 56,
    color: white,
    borderColor: borderGray,
    borderWidth: 0.5,
  })
  page.drawText("TRANSACTIONS & SETTLEMENT LOG", { x: marginX + 8, y: y - 12, size: 7.5, font: bold, color: darkNavy })
  if (data.transactions && data.transactions.length > 0) {
    const txn = data.transactions[0]
    page.drawText(`Latest Payment: ${fmtDate(txn.date)} via ${txn.gateway}`, { x: marginX + 8, y: y - 24, size: 7.5, font, color: textDark })
    page.drawText(`Txn ID: ${fit(txn.transactionId, txnBoxW - 80, font, 7.5)}`, { x: marginX + 8, y: y - 36, size: 7.5, font, color: textDark })
    page.drawText(`Amount Settled: Tk ${txn.amount.toFixed(2)}`, { x: marginX + 8, y: y - 48, size: 7.5, font: bold, color: greenStatus })
  } else {
    page.drawText("No prior settlement transactions recorded for this term.", { x: marginX + 8, y: y - 26, size: 7.5, font, color: textMuted })
    page.drawText("Select any of the remittance channels below to settle.", { x: marginX + 8, y: y - 40, size: 7.2, font, color: textMuted })
  }

  drawTotalLine("Subtotal (Net)", `Tk ${net.toFixed(2)}`)
  drawTotalLine(`VAT (${vatRate}% inclusive)`, `Tk ${vat.toFixed(2)}`)
  drawTotalLine("Paid", `(-) Tk ${paid.toFixed(2)}`)
  drawTotalLine("Total Due", `Tk ${due.toFixed(2)}`, true)

  y -= 12

  // =========================================================================
  // 5. TWO BOTTOM SIDE-BY-SIDE BOXES (The User-Requested Red Boxes)
  // Left Box: BANK TRANSFER / DEPOSIT (2 Banks)
  // Right Box: BKASH / BANGLA QR / NAGAD PAYMENT WITH QR CODE
  // =========================================================================
  const bottomBoxH = 148
  const bottomBoxW = (tableW - cardGap) / 2

  // ---------------- LEFT BOX: TWO BANK ACCOUNTS ----------------
  page.drawRectangle({
    x: marginX,
    y: y - bottomBoxH,
    width: bottomBoxW,
    height: bottomBoxH,
    color: white,
    borderColor: borderBlue,
    borderWidth: 0.8,
  })

  page.drawText("BANK TRANSFER / DEPOSIT (2 ACCOUNTS)", { x: marginX + 10, y: y - 14, size: 8, font: bold, color: primaryBlue })

  let leftBankY = y - 28
  // Primary Bank (City Bank)
  page.drawText("1. Primary Bank Account", { x: marginX + 10, y: leftBankY, size: 7.5, font: bold, color: darkNavy })
  leftBankY -= 11
  page.drawText(`Bank: ${data.primaryBank.bankName || "The City Bank Ltd."}`, { x: marginX + 10, y: leftBankY, size: 7.2, font, color: textDark })
  leftBankY -= 10
  page.drawText(`A/C: ${data.primaryBank.accountNo || "1233394761001"}   (${data.primaryBank.payeeName || data.companyLegalName})`, { x: marginX + 10, y: leftBankY, size: 7.2, font: bold, color: textDark })
  leftBankY -= 10
  page.drawText(`Branch: ${data.primaryBank.branch || "Shyamoli"} | Routing: ${data.primaryBank.routing || "225264300"}`, { x: marginX + 10, y: leftBankY, size: 7, font, color: textMuted })

  // Divider line between banks
  leftBankY -= 7
  page.drawLine({
    start: { x: marginX + 8, y: leftBankY },
    end: { x: marginX + bottomBoxW - 8, y: leftBankY },
    thickness: 0.5,
    color: borderGray,
  })

  // Secondary Bank (BRAC Bank)
  leftBankY -= 11
  page.drawText("2. Secondary Bank Account", { x: marginX + 10, y: leftBankY, size: 7.5, font: bold, color: darkNavy })
  leftBankY -= 11
  page.drawText(`Bank: ${data.secondaryBank.bankName || "BRAC Bank PLC"}`, { x: marginX + 10, y: leftBankY, size: 7.2, font, color: textDark })
  leftBankY -= 10
  page.drawText(`A/C: ${data.secondaryBank.accountNo || "2081769340001"}   (${data.secondaryBank.payeeName || data.companyLegalName})`, { x: marginX + 10, y: leftBankY, size: 7.2, font: bold, color: textDark })
  leftBankY -= 10
  page.drawText(`Branch: ${data.secondaryBank.branch || "Satmasjid Road Branch"} | Routing: ${data.secondaryBank.routing || "060276074"}`, { x: marginX + 10, y: leftBankY, size: 7, font, color: textMuted })

  // ---------------- RIGHT BOX: MFS / BANGLA QR / BKASH / NAGAD ----------------
  const rightBoxX = marginX + bottomBoxW + cardGap
  const mfsProvider = data.mfs?.providerName || "BKASH / BANGLA QR PAYMENT"
  const mfsNumber = data.mfs?.merchantNumber || data.bkash?.merchantNumber || "01943223366"

  page.drawRectangle({
    x: rightBoxX,
    y: y - bottomBoxH,
    width: bottomBoxW,
    height: bottomBoxH,
    color: white,
    borderColor: rgb(0.9, 0.45, 0.6),
    borderWidth: 0.8,
  })

  page.drawText(fit(mfsProvider.toUpperCase(), bottomBoxW - 20, bold, 8), {
    x: rightBoxX + 10,
    y: y - 14,
    size: 8,
    font: bold,
    color: mfsRose,
  })

  // QR Code on Left of Right Box
  const qrBoxSize = 92
  const qrX = rightBoxX + 10
  const qrY = y - bottomBoxH + 16

  let qrDrawn = false
  if (data.mfs?.qrUrl) {
    const customQr = await tryEmbedImage(doc, data.mfs.qrUrl)
    if (customQr) {
      page.drawImage(customQr.img, { x: qrX, y: qrY, width: qrBoxSize, height: qrBoxSize })
      qrDrawn = true
    }
  }
  if (!qrDrawn) {
    try {
      const qrPayload = `BanglaQR:Merchant=${mfsNumber}:Amount=${total}:Ref=${data.invoiceNumber}`
      const qrBuffer = await QRCode.toBuffer(qrPayload, { width: 100, margin: 1 })
      const qrImg = await doc.embedPng(qrBuffer)
      page.drawImage(qrImg, { x: qrX, y: qrY, width: qrBoxSize, height: qrBoxSize })
    } catch {
      page.drawRectangle({ x: qrX, y: qrY, width: qrBoxSize, height: qrBoxSize, color: lightGray, borderColor: borderGray, borderWidth: 0.5 })
      page.drawText("QR Code", { x: qrX + 22, y: qrY + 42, size: 8, font, color: textMuted })
    }
  }

  // Details & Instructions on Right of QR
  const mfsDetailsX = qrX + qrBoxSize + 10
  const mfsDetailsW = bottomBoxW - qrBoxSize - 22

  page.drawText("Merchant / A/C No:", { x: mfsDetailsX, y: y - 32, size: 7, font: bold, color: textDark })
  page.drawText(winAnsi(mfsNumber), { x: mfsDetailsX, y: y - 42, size: 8.5, font: bold, color: mfsRose })

  page.drawText("Invoice Reference:", { x: mfsDetailsX, y: y - 56, size: 7, font: bold, color: textDark })
  page.drawText(winAnsi(data.invoiceNumber), { x: mfsDetailsX, y: y - 66, size: 8, font: bold, color: textDark })

  page.drawText("HOW TO PAY", { x: mfsDetailsX, y: y - 82, size: 7.2, font: bold, color: primaryBlue })

  const instructions = [
    "1. Open bKash, Nagad or bank app.",
    "2. Scan QR or enter merchant no.",
    `3. Enter exact amount: Tk ${total.toFixed(2)}.`,
    `4. Enter Ref: ${data.invoiceNumber}.`,
  ]

  let instY = y - 93
  for (const inst of instructions) {
    page.drawText(fit(inst, mfsDetailsW, font, 6.7), { x: mfsDetailsX, y: instY, size: 6.7, font, color: textDark })
    instY -= 9.5
  }

  // Shared Finix HR Footer
  drawFinixFooter({
    page,
    pageW,
    marginX,
    platformName: data.platformName,
    websiteUrl: headerContact.websiteUrl,
    italicFont: oblique,
    regularFont: font,
    pageNumberText: "Computer Generated Tax Invoice",
  })

  return doc.save()
}

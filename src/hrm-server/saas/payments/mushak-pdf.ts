// ============ Official Bangladesh NBR Mushak-6.3 PDF Generator ============
// Generates an official, compliant, A4-size Bangladesh National Board of Revenue
// Mushak-6.3 VAT Tax Invoice with the authentic cyan/blue background (#74CCFC),
// Government of Bangladesh emblem, uploaded Authorized Signature & Seal,
// and complete 11-column NBR statutory tax table.
import { PDFDocument } from "pdf-lib"
import sharp from "sharp"
import { BD_GOVT_LOGO_PNG } from "./bd-govt-logo-base64"

export type MushakPdfData = {
  companyLegalName: string
  companyBin: string
  companyAddress: string
  customerName: string
  customerBin?: string | null
  customerAddress?: string | null
  invoiceNumber: string
  issuedAt: Date
  planName: string
  billingCycle: string
  periodStart: Date
  periodEnd: Date
  amount: number
  currency: string
  vatRatePercent: number
  netAmount: number
  vatAmount: number
  signatoryName?: string
  signatoryDesignation?: string
  signatureUrl?: string
  sealUrl?: string
}

function escapeXml(unsafe: string | null | undefined): string {
  if (!unsafe) return ""
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—"
  const day = String(d.getDate()).padStart(2, "0")
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const y = d.getFullYear()
  return `${day}/${m}/${y}`
}

function fmtTime(d: Date | null | undefined): string {
  if (!d) return "—"
  let h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, "0")
  const ampm = h >= 12 ? "PM" : "AM"
  h = h % 12 || 12
  return `${String(h).padStart(2, "0")}:${m} ${ampm}`
}

export async function renderMushakPdf(data: MushakPdfData): Promise<Uint8Array> {
  const issuedDate = new Date(data.issuedAt)
  const issueDateStr = fmtDate(issuedDate)
  const issueTimeStr = fmtTime(issuedDate)

  const periodStartStr = fmtDate(new Date(data.periodStart))
  const periodEndStr = fmtDate(new Date(data.periodEnd))

  const total = Number(data.amount) || 0
  const rate = Number(data.vatRatePercent) || 0
  const net = Number(data.netAmount) || 0
  const vat = Number(data.vatAmount) || 0

  const supplierName = data.companyLegalName || "FINIX HR LTD."
  const supplierBin = data.companyBin || "009377515-0111"
  const supplierAddress = data.companyAddress || "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230"

  const customerName = data.customerName || "Client"
  const customerBin = data.customerBin || "—"
  const customerAddress = data.customerAddress || "Dhaka, Bangladesh"

  const signatoryName = data.signatoryName || "MD JAKARIA"
  const signatoryDesignation = data.signatoryDesignation || "Executive, Admin & Operations, Finix HR Ltd."

  // High-resolution SVG canvas (1654 x 2338 pixels for crisp A4 print rendering)
  const W = 1654
  const H = 2338

  // Layout boundaries
  const leftX = 80
  const rightX = 1574
  const contentW = rightX - leftX // 1494

  // Table column widths (Total = 1494)
  const colW = [70, 394, 75, 75, 120, 130, 90, 110, 110, 140, 180]
  const colX: number[] = []
  let curX = leftX
  for (const w of colW) {
    colX.push(curX)
    curX += w
  }

  const tableTopY = 620
  const headerH1 = 80
  const headerH2 = 36
  const rowH = 150
  const totalH = 46

  const tableH = headerH1 + headerH2 + rowH + totalH
  const tableBottomY = tableTopY + tableH

  const signatureImgTag = data.signatureUrl
    ? `<image href="${escapeXml(data.signatureUrl)}" x="${leftX + 100}" y="${tableBottomY + 110}" width="180" height="60" preserveAspectRatio="xMinYMid meet"/>`
    : `<text x="${leftX + 110}" y="${tableBottomY + 145}" font-family="'Segoe UI', 'Times New Roman', serif" font-style="italic" font-size="28" font-weight="bold" fill="#000080">${escapeXml(signatoryName)}</text>`

  const sealImgTag = data.sealUrl
    ? `<image href="${escapeXml(data.sealUrl)}" x="${rightX - 160}" y="${tableBottomY + 50}" width="150" height="150" preserveAspectRatio="xMidYMid meet"/>`
    : `<g transform="translate(${rightX - 150}, ${tableBottomY + 50})">
        <circle cx="70" cy="70" r="66" fill="none" stroke="#1e3a8a" stroke-width="2.5" stroke-dasharray="6,4"/>
        <circle cx="70" cy="70" r="56" fill="none" stroke="#1e3a8a" stroke-width="1.5"/>
        <text x="70" y="52" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="bold" fill="#1e3a8a">FINIX HR</text>
        <text x="70" y="73" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="16" fill="#1e3a8a">★ ★ ★</text>
        <text x="70" y="94" text-anchor="middle" font-family="'Segoe UI', sans-serif" font-size="13" font-weight="bold" fill="#1e3a8a">LTD.</text>
      </g>`

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .txt { font-family: 'Segoe UI', 'Kalpurush', 'Noto Sans Bengali', 'Hind Siliguri', 'Arial', sans-serif; fill: #000; }
      .bld { font-weight: bold; }
    </style>
  </defs>

  <!-- Blue Background (matching Bangladesh NBR sample: #74CCFC) -->
  <rect width="100%" height="100%" fill="#74CCFC"/>

  <!-- Top-Left: Government of Bangladesh Emblem -->
  <image href="${BD_GOVT_LOGO_PNG}" x="${leftX}" y="45" width="125" height="125" preserveAspectRatio="xMidYMid meet"/>

  <!-- Top-Right: Form Copy & Mushak-6.3 Badge -->
  <text x="${rightX}" y="75" text-anchor="end" class="txt" font-size="22">প্রথম কপি</text>
  <rect x="${rightX - 160}" y="95" width="160" height="46" rx="23" fill="none" stroke="#000" stroke-width="2.5"/>
  <text x="${rightX - 80}" y="127" text-anchor="middle" class="txt bld" font-size="26">মূসক-৬.৩</text>

  <!-- Top-Center: Government & Tax Invoice Header -->
  <text x="${W / 2}" y="80" text-anchor="middle" class="txt bld" font-size="28">গণপ্রজাতন্ত্রী বাংলাদেশ সরকার, জাতীয় রাজস্ব বোর্ড</text>
  <text x="${W / 2}" y="130" text-anchor="middle" class="txt bld" font-size="38">কর চালানপত্র</text>
  <text x="${W / 2}" y="165" text-anchor="middle" class="txt" font-size="20">[বিধি ৪০ এর উপ-বিধি (১) এর দফা (গ) ও (চ) দ্রষ্টব্য]</text>

  <!-- Registered Supplier Info -->
  <text x="${W / 2}" y="225" text-anchor="middle" class="txt" font-size="22">
    <tspan font-weight="600">নিবন্ধিত ব্যক্তির নাম : </tspan>
    <tspan class="bld">${escapeXml(supplierName)}</tspan>
  </text>
  <text x="${W / 2}" y="260" text-anchor="middle" class="txt" font-size="22">
    <tspan font-weight="600">নিবন্ধিত ব্যক্তির বিআইএন : </tspan>
    <tspan class="bld font-mono">${escapeXml(supplierBin)}</tspan>
  </text>
  <text x="${W / 2}" y="295" text-anchor="middle" class="txt" font-size="22">
    <tspan font-weight="600">চালানপত্র ইস্যুর ঠিকানা : </tspan>
    <tspan>${escapeXml(supplierAddress)}</tspan>
  </text>

  <!-- Thin Section Divider -->
  <line x1="${leftX}" y1="325" x2="${rightX}" y2="325" stroke="#000" stroke-width="1" stroke-opacity="0.3"/>

  <!-- Customer & Invoice Info (2 Columns) -->
  <g class="txt" font-size="21">
    <!-- Left Column (Customer) -->
    <text x="${leftX}" y="365">
      <tspan font-weight="600">ক্রেতার নাম : </tspan>
      <tspan class="bld">${escapeXml(customerName)}</tspan>
    </text>
    <text x="${leftX}" y="405">
      <tspan font-weight="600">ক্রেতার বিআইএন (প্রযোজ্য ক্ষেত্রে) : </tspan>
      <tspan>${escapeXml(customerBin)}</tspan>
    </text>
    <text x="${leftX}" y="445">
      <tspan font-weight="600">ক্রেতার ঠিকানা : </tspan>
      <tspan>${escapeXml(customerAddress)}</tspan>
    </text>
    <text x="${leftX}" y="485">
      <tspan font-weight="600">সরবরাহের গন্তব্যস্থল : </tspan>
      <tspan>—</tspan>
    </text>
    <text x="${leftX}" y="525">
      <tspan font-weight="600">যানবাহনের প্রকৃতি ও নম্বর : </tspan>
      <tspan>—</tspan>
    </text>

    <!-- Right Column (Invoice) -->
    <text x="${rightX}" y="365" text-anchor="end">
      <tspan font-weight="600">চালানপত্র নম্বর : </tspan>
      <tspan class="bld font-mono">${escapeXml(data.invoiceNumber)}</tspan>
    </text>
    <text x="${rightX}" y="405" text-anchor="end">
      <tspan font-weight="600">ইস্যুর তারিখ : </tspan>
      <tspan class="bld font-mono">${escapeXml(issueDateStr)}</tspan>
    </text>
    <text x="${rightX}" y="445" text-anchor="end">
      <tspan font-weight="600">ইস্যুর সময় : </tspan>
      <tspan class="bld font-mono">${escapeXml(issueTimeStr)}</tspan>
    </text>
  </g>

  <!-- 11-Column Statutory NBR Table -->
  <g>
    <!-- Outer Table Border & Header Fills -->
    <rect x="${leftX}" y="${tableTopY}" width="${contentW}" height="${tableH}" fill="none" stroke="#000" stroke-width="2"/>
    <rect x="${leftX}" y="${tableTopY}" width="${contentW}" height="${headerH1 + headerH2}" fill="#63C4FC" stroke="#000" stroke-width="1.5"/>

    <!-- Horizontal Lines -->
    <line x1="${leftX}" y1="${tableTopY + headerH1}" x2="${rightX}" y2="${tableTopY + headerH1}" stroke="#000" stroke-width="1.5"/>
    <line x1="${leftX}" y1="${tableTopY + headerH1 + headerH2}" x2="${rightX}" y2="${tableTopY + headerH1 + headerH2}" stroke="#000" stroke-width="2"/>
    <line x1="${leftX}" y1="${tableBottomY - totalH}" x2="${rightX}" y2="${tableBottomY - totalH}" stroke="#000" stroke-width="1.5"/>

    <!-- Vertical Column Dividers -->
    ${colX.slice(1).map((x) => `<line x1="${x}" y1="${tableTopY}" x2="${x}" y2="${tableBottomY}" stroke="#000" stroke-width="1.5"/>`).join("\n    ")}

    <!-- Header Text: Row 1 -->
    <g class="txt bld" font-size="17" text-anchor="middle">
      <text x="${colX[0] + colW[0] / 2}" y="${tableTopY + 45}">ক্রম নম্বর</text>
      
      <text x="${colX[1] + 16}" y="${tableTopY + 35}" text-anchor="start">পণ্য বা সেবার বিবরণ</text>
      <text x="${colX[1] + 16}" y="${tableTopY + 60}" text-anchor="start" font-size="15">(প্রযোজ্য ক্ষেত্রে ব্র্যান্ড নামসহ)</text>

      <text x="${colX[2] + colW[2] / 2}" y="${tableTopY + 35}">সরবরাহের</text>
      <text x="${colX[2] + colW[2] / 2}" y="${tableTopY + 60}">একক</text>

      <text x="${colX[3] + colW[3] / 2}" y="${tableTopY + 45}">পরিমাণ</text>

      <text x="${colX[4] + colW[4] / 2}" y="${tableTopY + 35}">একক মূল্য ১</text>
      <text x="${colX[4] + colW[4] / 2}" y="${tableTopY + 60}">(টাকায়)</text>

      <text x="${colX[5] + colW[5] / 2}" y="${tableTopY + 35}">মোট মূল্য</text>
      <text x="${colX[5] + colW[5] / 2}" y="${tableTopY + 60}">(টাকায়)</text>

      <text x="${colX[6] + colW[6] / 2}" y="${tableTopY + 35}">সম্পূরক</text>
      <text x="${colX[6] + colW[6] / 2}" y="${tableTopY + 60}">শুল্কের হার</text>

      <text x="${colX[7] + colW[7] / 2}" y="${tableTopY + 28}">সম্পূরক</text>
      <text x="${colX[7] + colW[7] / 2}" y="${tableTopY + 50}">শুল্কের পরিমাণ</text>
      <text x="${colX[7] + colW[7] / 2}" y="${tableTopY + 70}">(টাকায়)</text>

      <text x="${colX[8] + colW[8] / 2}" y="${tableTopY + 25}">মূল্য সংযোজন</text>
      <text x="${colX[8] + colW[8] / 2}" y="${tableTopY + 46}">করের হার/</text>
      <text x="${colX[8] + colW[8] / 2}" y="${tableTopY + 67}">নির্দিষ্ট কর</text>

      <text x="${colX[9] + colW[9] / 2}" y="${tableTopY + 24}">মূল্য সংযোজন</text>
      <text x="${colX[9] + colW[9] / 2}" y="${tableTopY + 44}">কর/সুনির্দিষ্ট কর</text>
      <text x="${colX[9] + colW[9] / 2}" y="${tableTopY + 64}">এর পরিমাণ (টাকায়)</text>

      <text x="${colX[10] + colW[10] / 2}" y="${tableTopY + 35}">সকল প্রকার শুল্ক</text>
      <text x="${colX[10] + colW[10] / 2}" y="${tableTopY + 60}">ও করসহ মূল্য</text>
    </g>

    <!-- Header Text: Row 2 (Columns (১) - (১১)) -->
    <g class="txt" font-size="16" text-anchor="middle">
      <text x="${colX[0] + colW[0] / 2}" y="${tableTopY + headerH1 + 24}">(১)</text>
      <text x="${colX[1] + colW[1] / 2}" y="${tableTopY + headerH1 + 24}">(২)</text>
      <text x="${colX[2] + colW[2] / 2}" y="${tableTopY + headerH1 + 24}">(৩)</text>
      <text x="${colX[3] + colW[3] / 2}" y="${tableTopY + headerH1 + 24}">(৪)</text>
      <text x="${colX[4] + colW[4] / 2}" y="${tableTopY + headerH1 + 24}">(৫)</text>
      <text x="${colX[5] + colW[5] / 2}" y="${tableTopY + headerH1 + 24}">(৬)</text>
      <text x="${colX[6] + colW[6] / 2}" y="${tableTopY + headerH1 + 24}">(৭)</text>
      <text x="${colX[7] + colW[7] / 2}" y="${tableTopY + headerH1 + 24}">(৮)</text>
      <text x="${colX[8] + colW[8] / 2}" y="${tableTopY + headerH1 + 24}">(৯)</text>
      <text x="${colX[9] + colW[9] / 2}" y="${tableTopY + headerH1 + 24}">(১০)</text>
      <text x="${colX[10] + colW[10] / 2}" y="${tableTopY + headerH1 + 24}">(১১)</text>
    </g>

    <!-- Data Row -->
    <g class="txt" font-size="18">
      <!-- Col 1: ক্রম -->
      <text x="${colX[0] + colW[0] / 2}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="middle" class="bld">১</text>

      <!-- Col 2: পণ্যের বিবরণ -->
      <text x="${colX[1] + 16}" y="${tableTopY + headerH1 + headerH2 + 32}" class="bld">Finix HR - ${escapeXml(data.planName)} Plan</text>
      <text x="${colX[1] + 16}" y="${tableTopY + headerH1 + headerH2 + 60}" font-size="16">Billing Cycle: ${escapeXml(data.billingCycle.toLowerCase())}</text>
      <text x="${colX[1] + 16}" y="${tableTopY + headerH1 + headerH2 + 88}" font-size="16">Billing Period: ${escapeXml(periodStartStr)} - ${escapeXml(periodEndStr)}</text>
      <text x="${colX[1] + 16}" y="${tableTopY + headerH1 + headerH2 + 116}" font-size="15">Specification: Cloud Workforce &amp; Payroll Management Platform</text>

      <!-- Col 3: একক -->
      <text x="${colX[2] + colW[2] / 2}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="middle">—</text>

      <!-- Col 4: পরিমাণ -->
      <text x="${colX[3] + colW[3] / 2}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="middle">1.00</text>

      <!-- Col 5: একক মূল্য -->
      <text x="${colX[4] + colW[4] - 12}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="end">${net.toFixed(2)}</text>

      <!-- Col 6: মোট মূল্য -->
      <text x="${colX[5] + colW[5] - 12}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="end" class="bld">${net.toFixed(2)}</text>

      <!-- Col 7: সম্পূরক শুল্ক হার -->
      <text x="${colX[6] + colW[6] / 2}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="middle">—</text>

      <!-- Col 8: সম্পূরক শুল্ক পরিমাণ -->
      <text x="${colX[7] + colW[7] / 2}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="middle">—</text>

      <!-- Col 9: মূসক হার -->
      <text x="${colX[8] + colW[8] / 2}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="middle" class="bld">${rate.toFixed(2)}%</text>

      <!-- Col 10: মূসক পরিমাণ -->
      <text x="${colX[9] + colW[9] - 12}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="end" class="bld">${vat.toFixed(2)}</text>

      <!-- Col 11: সর্বমোট মূল্য -->
      <text x="${colX[10] + colW[10] - 12}" y="${tableTopY + headerH1 + headerH2 + 35}" text-anchor="end" class="bld">${total.toFixed(2)}</text>
    </g>

    <!-- Total Row (সর্বমোট) -->
    <g class="txt bld" font-size="19">
      <text x="${colX[4] - 16}" y="${tableBottomY - 16}" text-anchor="end">সর্বমোট</text>
      <text x="${colX[4] + colW[4] - 12}" y="${tableBottomY - 16}" text-anchor="end">${net.toFixed(2)}</text>
      <text x="${colX[5] + colW[5] - 12}" y="${tableBottomY - 16}" text-anchor="end">${net.toFixed(2)}</text>
      <text x="${colX[6] + colW[6] / 2}" y="${tableBottomY - 16}" text-anchor="middle">—</text>
      <text x="${colX[7] + colW[7] / 2}" y="${tableBottomY - 16}" text-anchor="middle">—</text>
      <text x="${colX[8] + colW[8] / 2}" y="${tableBottomY - 16}" text-anchor="middle">${rate.toFixed(2)}%</text>
      <text x="${colX[9] + colW[9] - 12}" y="${tableBottomY - 16}" text-anchor="end">${vat.toFixed(2)}</text>
      <text x="${colX[10] + colW[10] - 12}" y="${tableBottomY - 16}" text-anchor="end" font-size="21">${total.toFixed(2)}</text>
    </g>
  </g>

  <!-- Signatory & Official Seal Section -->
  <g class="txt">
    <text x="${leftX}" y="${tableBottomY + 45}" font-size="21">
      <tspan font-weight="600">প্রতিষ্ঠান কর্তৃপক্ষের দায়িত্বপ্রাপ্ত ব্যক্তির নাম: </tspan>
      <tspan class="bld">${escapeXml(signatoryName)}</tspan>
    </text>
    <text x="${leftX}" y="${tableBottomY + 80}" font-size="21">
      <tspan font-weight="600">পদবি: </tspan>
      <tspan>${escapeXml(signatoryDesignation)}</tspan>
    </text>
    <text x="${leftX}" y="${tableBottomY + 140}" font-size="22" font-weight="600">স্বাক্ষর:</text>
    
    ${signatureImgTag}
    ${sealImgTag}

    <!-- Footnote -->
    <text x="${leftX}" y="${tableBottomY + 220}" font-size="18" font-style="italic">১ সকল প্রকার কর ব্যতীত মূল্য</text>

    <!-- Bottom Page Indicator -->
    <line x1="${leftX}" y1="${tableBottomY + 250}" x2="${rightX}" y2="${tableBottomY + 250}" stroke="#000" stroke-width="1" stroke-opacity="0.2"/>
    <text x="${W / 2}" y="${tableBottomY + 285}" text-anchor="middle" font-size="18" fill="#333">Page 1 of 1</text>
  </g>
</svg>`

  // Convert SVG to high-definition PNG buffer via sharp
  const pngBuffer = await sharp(Buffer.from(svg))
    .png({ quality: 100 })
    .toBuffer()

  // Embed into a strict 1-page A4 PDFDocument
  const doc = await PDFDocument.create()
  const pageW = 595.28 // Standard A4 portrait
  const pageH = 841.89
  const page = doc.addPage([pageW, pageH])

  const embeddedPng = await doc.embedPng(pngBuffer)
  page.drawImage(embeddedPng, {
    x: 0,
    y: 0,
    width: pageW,
    height: pageH,
  })

  return await doc.save()
}

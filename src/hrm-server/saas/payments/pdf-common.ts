// ============ Shared Finix HR Corporate PDF Primitives & Branding ============
// Provides shared WinAnsi string sanitization, vector icon renderers, image embedding,
// and identical professional Header and Footer styling for Invoices and Money Receipts.
import { PDFDocument, rgb } from "pdf-lib"

export const winAnsi = (t: any): string =>
  String(t ?? "")
    .replace(/\u2192|\u2794|\u27a1/g, "-") // arrows
    .replace(/\u2190|\u2191|\u2193/g, "-")
    .replace(/\u2013|\u2014/g, "-") // en/em dash
    .replace(/\u2605|\u2606/g, "*") // stars
    .replace(/\u00b7/g, "\u00b7")
    .replace(/[^\x20-\x7E\xA0-\xFF\u2026]/g, "") // WinAnsi-safe range

export const fit = (text: any, maxW: number, f: any, size: number): string => {
  let t = winAnsi(text)
  if (f.widthOfTextAtSize(t, size) <= maxW) return t
  while (t.length > 1 && f.widthOfTextAtSize(t + "...", size) > maxW) t = t.slice(0, -1)
  return t + "..."
}

export const fmtDate = (d: Date | null | undefined): string => {
  if (!d) return "-"
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const day = String(d.getDate()).padStart(2, "0")
  const m = months[d.getMonth()]
  const y = d.getFullYear()
  return `${day} ${m} ${y}`
}

export const fmtDateTime = (d: Date | null | undefined): string => {
  if (!d) return "-"
  const dStr = fmtDate(d)
  let h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, "0")
  const ampm = h >= 12 ? "PM" : "AM"
  h = h % 12 || 12
  return `${dStr}, ${h}:${m} ${ampm}`
}

export async function tryEmbedImage(doc: PDFDocument, urlOrBase64?: string): Promise<{ img: any; width: number; height: number } | null> {
  if (!urlOrBase64 || typeof urlOrBase64 !== "string") return null
  const cleaned = urlOrBase64.trim()
  let isJpg = false
  let rawB64 = ""
  const m = cleaned.match(/^data:image\/(png|jpe?g);base64,(.+)$/i)
  if (m) {
    isJpg = m[1].toLowerCase().startsWith("jp")
    rawB64 = m[2]
  } else if (/^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length > 50) {
    rawB64 = cleaned
    try {
      const b = Buffer.from(cleaned.slice(0, 16), "base64")
      if (b[0] === 0xff && b[1] === 0xd8) isJpg = true
    } catch {}
  }
  if (!rawB64) return null
  try {
    const bytes = Uint8Array.from(Buffer.from(rawB64, "base64"))
    const img = isJpg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
    return { img, width: img.width, height: img.height }
  } catch {
    try {
      const bytes = Uint8Array.from(Buffer.from(rawB64, "base64"))
      const img = !isJpg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
      return { img, width: img.width, height: img.height }
    } catch {
      return null
    }
  }
}

// ---------------- Vector Icon Drawing Helpers ----------------

export function drawGlobeIcon(page: any, x: number, y: number, color: any) {
  const cx = x + 4
  const cy = y + 4
  const r = 3.8
  page.drawCircle({ x: cx, y: cy, size: r, borderColor: color, borderWidth: 0.75 })
  page.drawLine({ start: { x: cx - r + 0.4, y: cy }, end: { x: cx + r - 0.4, y: cy }, thickness: 0.65, color })
  page.drawLine({ start: { x: cx, y: cy - r + 0.4 }, end: { x: cx, y: cy + r - 0.4 }, thickness: 0.65, color })
}

export function drawMailIcon(page: any, x: number, y: number, color: any) {
  page.drawRectangle({ x, y: y + 0.8, width: 8.5, height: 6.2, borderColor: color, borderWidth: 0.75 })
  page.drawLine({ start: { x: x + 0.5, y: y + 6.8 }, end: { x: x + 4.25, y: y + 3.8 }, thickness: 0.65, color })
  page.drawLine({ start: { x: x + 8.0, y: y + 6.8 }, end: { x: x + 4.25, y: y + 3.8 }, thickness: 0.65, color })
}

export function drawMapPinIcon(page: any, x: number, y: number, color: any, white: any) {
  const cx = x + 4
  const cy = y + 5.5
  page.drawCircle({ x: cx, y: cy, size: 2.6, color, borderColor: color, borderWidth: 0.6 })
  page.drawCircle({ x: cx, y: cy, size: 0.9, color: white })
  page.drawLine({ start: { x: cx - 2.0, y: cy - 0.8 }, end: { x: cx, y: y }, thickness: 0.75, color })
  page.drawLine({ start: { x: cx + 2.0, y: cy - 0.8 }, end: { x: cx, y: y }, thickness: 0.75, color })
}

// ---------------- Shared Header ----------------

export async function drawFinixHeader(params: {
  doc: PDFDocument
  page: any
  pageW: number
  pageH: number
  marginX: number
  data: {
    platformName?: string
    tagline?: string
    websiteUrl?: string
    supportEmail?: string
    companyAddress?: string
    logoUrl?: string
  }
  boldFont: any
  regularFont: any
}): Promise<number> {
  const { doc, page, pageW, pageH, marginX, data, boldFont, regularFont } = params

  const primaryBlue = rgb(0.145, 0.388, 0.92) // #2563eb
  const darkNavy = rgb(0.09, 0.13, 0.33)    // #172254
  const slateDark = rgb(0.09, 0.12, 0.18)   // #1e293b
  const slateMuted = rgb(0.39, 0.45, 0.55)  // #64748b
  const white = rgb(1, 1, 1)

  const y = pageH - 42

  // 1. Left side branding (Logo + Platform Name + Tagline)
  const embeddedLogo = await tryEmbedImage(doc, data.logoUrl)
  if (embeddedLogo) {
    const scale = Math.min(32 / embeddedLogo.height, 90 / embeddedLogo.width, 1)
    const lw = embeddedLogo.width * scale
    const lh = embeddedLogo.height * scale
    page.drawImage(embeddedLogo.img, { x: marginX, y: y - lh + 4, width: lw, height: lh })
    page.drawText(winAnsi(data.platformName || "Finix HR"), { x: marginX + lw + 8, y: y - 8, size: 16, font: boldFont, color: darkNavy })
    page.drawText(winAnsi(data.tagline || "Standalone HRM & Workforce Platform"), { x: marginX + lw + 8, y: y - 22, size: 8, font: regularFont, color: slateMuted })
  } else {
    // Stylized royal-blue rounded logo box with white "F"
    page.drawRectangle({ x: marginX, y: y - 26, width: 28, height: 28, color: primaryBlue, borderColor: primaryBlue })
    page.drawText("F", { x: marginX + 8, y: y - 21, size: 20, font: boldFont, color: white })
    page.drawText(winAnsi(data.platformName || "Finix HR"), { x: marginX + 36, y: y - 10, size: 17, font: boldFont, color: darkNavy })
    page.drawText(winAnsi(data.tagline || "Standalone HRM & Workforce Platform"), { x: marginX + 36, y: y - 24, size: 8, font: regularFont, color: slateMuted })
  }

  // 2. Right side contact information with vector icons
  const rightColX = pageW - marginX - 170
  page.drawText(winAnsi(data.platformName || "Finix HR"), { x: rightColX, y: y - 2, size: 9.5, font: boldFont, color: slateDark })
  page.drawText("Smarter People. Stronger Teams.", { x: rightColX, y: y - 13, size: 7.5, font: regularFont, color: slateMuted })

  // Website line with Globe icon
  drawGlobeIcon(page, rightColX, y - 25, primaryBlue)
  page.drawText(fit(data.websiteUrl || "https://hrm.finixmart.com.bd", 155, regularFont, 7.5), {
    x: rightColX + 13,
    y: y - 23,
    size: 7.5,
    font: regularFont,
    color: slateDark,
  })

  // Email line with Mail icon
  drawMailIcon(page, rightColX, y - 36, primaryBlue)
  page.drawText(fit(data.supportEmail || "support@finixhr.com", 155, regularFont, 7.5), {
    x: rightColX + 13,
    y: y - 34,
    size: 7.5,
    font: regularFont,
    color: slateDark,
  })

  // Address line with Location Pin icon
  drawMapPinIcon(page, rightColX, y - 47, primaryBlue, white)
  page.drawText(fit(data.companyAddress || "Dhaka, Bangladesh", 155, regularFont, 7.5), {
    x: rightColX + 13,
    y: y - 45,
    size: 7.5,
    font: regularFont,
    color: slateDark,
  })

  // Blue divider line below header
  const nextY = y - 56
  page.drawLine({
    start: { x: marginX, y: nextY },
    end: { x: pageW - marginX, y: nextY },
    thickness: 1.2,
    color: primaryBlue,
  })

  return nextY - 20
}

// ---------------- Shared Footer ----------------

export function drawFinixFooter(params: {
  page: any
  pageW: number
  marginX: number
  platformName?: string
  websiteUrl?: string
  italicFont: any
  regularFont: any
  pageNumberText?: string
}) {
  const { page, pageW, marginX, platformName, websiteUrl, italicFont, regularFont, pageNumberText } = params

  const primaryBlue = rgb(0.145, 0.388, 0.92) // #2563eb
  const slateMuted = rgb(0.39, 0.45, 0.55)  // #64748b

  // Thin blue divider rule
  page.drawLine({
    start: { x: marginX, y: 36 },
    end: { x: pageW - marginX, y: 36 },
    thickness: 0.8,
    color: primaryBlue,
  })

  // Left: Slogan in italic script
  page.drawText("Building a better workplace together", {
    x: marginX,
    y: 24,
    size: 8.5,
    font: italicFont,
    color: primaryBlue,
  })

  // Center (optional page text or computer generated disclaimer)
  if (pageNumberText) {
    page.drawText(winAnsi(pageNumberText), {
      x: pageW / 2 - 45,
      y: 24,
      size: 7.5,
      font: regularFont,
      color: slateMuted,
    })
  }

  // Right: Platform Name | Website URL
  const footRight = `${platformName || "Finix HR"} | ${websiteUrl || "https://hrm.finixmart.com.bd"}`
  page.drawText(fit(footRight, 200, regularFont, 7.5), {
    x: pageW - marginX - 195,
    y: 24,
    size: 7.5,
    font: regularFont,
    color: slateMuted,
  })

  // Bottom artistic wave accent
  try {
    page.drawSvgPath(
      `M 0 0 L 0 14 Q ${pageW * 0.28} 20, ${pageW * 0.58} 10 T ${pageW} 16 L ${pageW} 0 Z`,
      { x: 0, y: 0, color: primaryBlue }
    )
  } catch {}
}

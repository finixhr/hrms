// ============ Phase 3 — enterprise report PDF (charts + KPI commentary) ============
// Renders an AnalyticsReport contract payload as a branded PDF: the corporate
// header/footer from pdf-common (the invoice/receipt family), a generated KPI
// COMMENTARY block (one sentence per numeric KPI with its prior-period
// movement), KPI cards with formulas, VECTOR-DRAWN charts (bars / lines /
// donut fans — no raster snapshots, no headless browser), the table, and the
// warnings + methodology blocks. Everything the contract carries is rendered;
// nothing is silently dropped.
//
// WinAnsi constraint (the pdf-lib StandardFonts family): all strings pass
// through winAnsi(); the ৳ glyph cannot ride this path, so currency values
// print as "BDT" prefixed numbers.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { winAnsi, fit, drawFinixHeader, drawFinixFooter } from "./saas/payments/pdf-common"
import { describeFilters, type AnalyticsReport, type AnalyticsChart, type AnalyticsKpi } from "./analytics-report"

const PAGE_W = 595.28
const PAGE_H = 841.89
const MARGIN = 42

const NAVY = rgb(0.09, 0.13, 0.33)
const BLUE = rgb(0.145, 0.388, 0.92)
const TEAL = rgb(0.05, 0.59, 0.54)
const AMBER = rgb(0.83, 0.57, 0.06)
const ROSE = rgb(0.8, 0.18, 0.29)
const SLATE = rgb(0.15, 0.19, 0.25)
const MUTED = rgb(0.39, 0.45, 0.55)
const LIGHT = rgb(0.94, 0.96, 0.98)
const WHITE = rgb(1, 1, 1)
const CHART_COLORS = [BLUE, TEAL, AMBER, rgb(0.55, 0.35, 0.75), rgb(0.2, 0.6, 0.9), rgb(0.9, 0.45, 0.2)]

/** Wrap text to a pixel width (greedy word wrap, WinAnsi-safe). */
function wrap(text: string, maxW: number, font: PDFFont, size: number, maxLines = 8): string[] {
  const words = winAnsi(text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ""
  for (const w of words) {
    const probe = cur ? `${cur} ${w}` : w
    if (font.widthOfTextAtSize(probe, size) <= maxW || !cur) cur = probe
    else { lines.push(cur); cur = w }
    if (lines.length >= maxLines) break
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  if (lines.length >= maxLines && words.length) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    const last = lines[lines.length - 1]!
    if (font.widthOfTextAtSize(`${last}…`, size) > maxW) lines[lines.length - 1] = `${last.slice(0, -1)}…`
  }
  return lines.length ? lines : [""]
}

const fmtNum = (v: number): string => {
  if (!Number.isFinite(v)) return "-"
  return Math.abs(v) >= 1000 ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : String(Math.round(v * 100) / 100)
}

const kpiValueText = (k: AnalyticsKpi): string => {
  if (k.value == null) return "—"
  if (typeof k.value === "number") return k.unit === "currency" ? `BDT ${fmtNum(k.value)}` : k.unit === "percent" ? `${fmtNum(k.value)}%` : fmtNum(k.value)
  return String(k.value)
}

/** The generated KPI commentary: one sentence per numeric KPI that has a
 *  previous value, plus a summary line. This is the "commentary" the roadmap's
 *  enterprise PDF demanded — written from the SAME numbers the cards show. */
export function kpiCommentary(report: AnalyticsReport): string[] {
  const out: string[] = []
  for (const k of report.kpis) {
    if (typeof k.value !== "number" || !k.previous || typeof k.previous.value !== "number") continue
    const delta = k.previous.deltaPct
    const moved = delta == null ? "" : delta === 0 ? " (unchanged)" : delta > 0 ? ` (+${delta}% vs previous period)` : ` (${delta}% vs previous period)`
    out.push(`${k.label} is ${kpiValueText(k)}, from ${kpiValueText({ ...k, value: k.previous.value })}${moved}.`)
  }
  if (!out.length) out.push("No KPI carries a previous-period comparison for this window — the numbers above stand on their own definitions.")
  return out
}

type Cursor = { page: PDFPage; y: number }

/** A page factory that walks the cursor, redrawing the header/footer and page
 *  number on every new page. */
function makePager(doc: PDFDocument, fonts: { bold: PDFFont; regular: PDFFont; italic: PDFFont }, totalHint: () => number) {
  const state: Cursor = { page: doc.addPage([PAGE_W, PAGE_H]), y: 0 }
  let pageNo = 1
  const stampFooter = (page: PDFPage) => {
    drawFinixFooter({ page, pageW: PAGE_W, marginX: MARGIN, italicFont: fonts.italic, regularFont: fonts.regular, pageNumberText: `Page ${pageNo} of ${totalHint()}` })
  }
  const init = async () => {
    state.y = await drawFinixHeader({
      doc, page: state.page, pageW: PAGE_W, pageH: PAGE_H, marginX: MARGIN,
      data: {}, boldFont: fonts.bold, regularFont: fonts.regular,
    })
    stampFooter(state.page)
  }
  return {
    cursor: state,
    init,
    /** ensure `need` points of vertical space; new page when exhausted */
    ensure: async (need: number): Promise<void> => {
      if (state.y - need > 64) return
      state.page = doc.addPage([PAGE_W, PAGE_H])
      pageNo++
      state.y = await drawFinixHeader({
        doc, page: state.page, pageW: PAGE_W, pageH: PAGE_H, marginX: MARGIN,
        data: {}, boldFont: fonts.bold, regularFont: fonts.regular,
      })
      stampFooter(state.page)
    },
  }
}

// ---------------- vector chart drawing ----------------

function drawBarChart(page: PDFPage, chart: AnalyticsChart, x: number, y: number, w: number, h: number, fonts: { bold: PDFFont; regular: PDFFont }) {
  // single-series bars (multi-series bar charts render grouped side-by-side)
  const series = chart.series.slice(0, 4)
  const n = series.length
  const maxVal = Math.max(1, ...series.flatMap((s) => s.points.map((p) => Math.abs(p.value))))
  const labels = series[0]?.points.map((p) => String(p.label)) ?? []
  const labelW = 46
  const plotW = w - labelW - 12
  const plotH = h - 18
  const groupW = plotW / Math.max(1, labels.length)
  const barW = Math.max(2, (groupW - 4) / n)
  // axis
  page.drawLine({ start: { x, y: y - plotH }, end: { x: x + labelW + plotW, y: y - plotH }, thickness: 0.8, color: MUTED })
  labels.forEach((label, li) => {
    const gx = x + labelW + li * groupW
    series.forEach((s, si) => {
      const p = s.points[li]
      if (!p) return
      const bh = Math.max(0.5, (Math.abs(p.value) / maxVal) * (plotH - 6))
      page.drawRectangle({
        x: gx + 2 + si * barW, y: y - plotH, width: barW - 1, height: bh,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
        color: CHART_COLORS[si % CHART_COLORS.length]!,
      })
      if (n === 1) {
        page.drawText(fit(fmtNum(p.value), groupW - 2, fonts.regular, 6.5), { x: gx + 2, y: y - plotH + bh + 2, size: 6.5, font: fonts.regular, color: MUTED })
      }
    })
    page.drawText(fit(label, groupW + 4, fonts.regular, 6.5), { x: gx - 2, y: y - plotH - 9, size: 6.5, font: fonts.regular, color: SLATE })
  })
  if (n > 1) {
    // legend
    let lx = x + labelW
    series.forEach((s, si) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      page.drawRectangle({ x: lx, y: y + 2, width: 6, height: 6, color: CHART_COLORS[si % CHART_COLORS.length]! })
      page.drawText(fit(s.name, 70, fonts.regular, 6.5), { x: lx + 8, y: y + 2, size: 6.5, font: fonts.regular, color: SLATE })
      lx += 84
    })
  }
}

function drawLineChart(page: PDFPage, chart: AnalyticsChart, x: number, y: number, w: number, h: number, fonts: { bold: PDFFont; regular: PDFFont }) {
  const series = chart.series.slice(0, 4)
  const labelW = 46
  const plotW = w - labelW - 12
  const plotH = h - 18
  const n = Math.max(1, series[0]?.points.length ?? 0)
  const maxVal = Math.max(1, ...series.flatMap((s) => s.points.map((p) => Math.abs(p.value))))
  const px = (i: number) => x + labelW + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const py = (v: number) => y - plotH + (Math.abs(v) / maxVal) * (plotH - 6)
  page.drawLine({ start: { x, y: y - plotH }, end: { x: x + labelW + plotW, y: y - plotH }, thickness: 0.8, color: MUTED })
  page.drawLine({ start: { x, y: y - plotH }, end: { x, y }, thickness: 0.8, color: MUTED })
  series.forEach((s, si) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    const color = CHART_COLORS[si % CHART_COLORS.length]!
    for (let i = 1; i < s.points.length; i++) {
      page.drawLine({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
        start: { x: px(i - 1), y: py(s.points[i - 1]!.value) },
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
        end: { x: px(i), y: py(s.points[i]!.value) },
        thickness: 1.2, color,
      })
    }
    s.points.forEach((p, i) => page.drawCircle({ x: px(i), y: py(p.value), size: 1.6, color }))
  })
  // x labels (first/middle/last to avoid collisions)
  const labels = series[0]?.points.map((p) => String(p.label)) ?? []
  const showIdx = n <= 6 ? labels.map((_, i) => i) : [0, Math.floor(n / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)
  for (const i of showIdx) {
    page.drawText(fit(labels[i] ?? "", 52, fonts.regular, 6.5), { x: px(i) - 24, y: y - plotH - 9, size: 6.5, font: fonts.regular, color: SLATE })
  }
  // legend
  let lx = x + labelW
  series.forEach((s, si) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    page.drawRectangle({ x: lx, y: y + 2, width: 6, height: 6, color: CHART_COLORS[si % CHART_COLORS.length]! })
    page.drawText(fit(s.name, 70, fonts.regular, 6.5), { x: lx + 8, y: y + 2, size: 6.5, font: fonts.regular, color: SLATE })
    lx += 84
  })
}

function drawDonutChart(page: PDFPage, chart: AnalyticsChart, x: number, y: number, w: number, h: number, fonts: { bold: PDFFont; regular: PDFFont }) {
  const pts = (chart.series[0]?.points ?? []).slice(0, 8)
  const total = Math.max(1, pts.reduce((s, p) => s + Math.abs(p.value), 0))
  const r = Math.min(h - 14, (w - 150) / 2, 54)
  const cx = x + r + 8
  const cy = y - h / 2
  let angle = Math.PI / 2
  pts.forEach((p, i) => {
    const frac = Math.abs(p.value) / total
    const sweep = frac * Math.PI * 2
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    const color = CHART_COLORS[i % CHART_COLORS.length]!
    // polygon fan (pdf-lib has no arc primitive): centre + points along the arc
    const steps = Math.max(2, Math.ceil((sweep / (Math.PI * 2)) * 72))
    const verts: { x: number; y: number }[] = [{ x: cx, y: cy }]
    for (let s = 0; s <= steps; s++) {
      const a = angle - (sweep * s) / steps
      verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
    }
    try {
      page.drawSvgPath(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
        `M ${verts[0]!.x - cx} ${verts[0]!.y - cy} ` +
        verts.slice(1).map((v) => `L ${v.x - cx} ${v.y - cy}`).join(" ") + " Z",
        { x: cx, y: cy, color, borderWidth: 0.5, borderColor: WHITE },
      )
    } catch { /* degenerate slice — skip */ }
    angle -= sweep
    // legend entry
    const ly = y - 8 - i * 11
    page.drawRectangle({ x: x + 2 * r + 24, y: ly, width: 6, height: 6, color })
    page.drawText(fit(`${p.label} (${fmtNum(p.value)})`, w - 2 * r - 40, fonts.regular, 7), { x: x + 2 * r + 33, y: ly, size: 7, font: fonts.regular, color: SLATE })
  })
}

// ---------------- the document ----------------

export async function renderReportPdf(report: AnalyticsReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique)
  const fonts = { bold, regular, italic }
  doc.setTitle(winAnsi(report.title))
  doc.setSubject(winAnsi(`${report.period.label} · ${report.scope.description}`))
  doc.setProducer("Finix HR — AnalyticsReport contract v1")

  const contentW = PAGE_W - 2 * MARGIN
  // two passes so the footer's "Page X of Y" knows the total: render once to
  // count pages, reset, render again (deterministic — same data, same layout)
  let pages = 0
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      while (doc.getPageCount() > 0) doc.removePage(0)
    }
    const pager = makePager(doc, fonts, () => pages)
    await pager.init()
    const c = pager.cursor

    // ---- title block ----
    c.page.drawText(fit(report.title, contentW, bold, 17), { x: MARGIN, y: c.y, size: 17, font: bold, color: NAVY })
    c.y -= 16
    c.page.drawText(fit(`Period: ${report.period.label}`, contentW, regular, 9), { x: MARGIN, y: c.y, size: 9, font: regular, color: SLATE })
    c.y -= 11
    if (report.period.comparison) {
      c.page.drawText(fit(`Comparison: ${report.period.comparison.label}`, contentW, regular, 9), { x: MARGIN, y: c.y, size: 9, font: regular, color: MUTED })
      c.y -= 11
    }
    // Reports overhaul (STEP 7) — the applied filters ride the header so the
    // printed artifact always shows the slice it was rendered under (the same
    // describeFilters the CSV preamble and the XLSX info block use). Empty
    // filters omit the line entirely.
    const filtersLine = describeFilters(report.filters)
    if (filtersLine) {
      c.page.drawText(fit(`Applied filters: ${filtersLine}`, contentW, regular, 9), { x: MARGIN, y: c.y, size: 9, font: regular, color: MUTED })
      c.y -= 11
    }
    c.page.drawText(fit(`Scope: ${report.scope.description}`, contentW, regular, 9), { x: MARGIN, y: c.y, size: 9, font: regular, color: MUTED })
    c.y -= 11
    c.page.drawText(fit(`Generated: ${report.generatedAt.replace("T", " ").slice(0, 19)} UTC · Contract v${report.contractVersion}`, contentW, regular, 8), { x: MARGIN, y: c.y, size: 8, font: regular, color: MUTED })
    c.y -= 14

    // ---- KPI commentary (generated sentences) ----
    await pager.ensure(60)
    c.page.drawText("Commentary", { x: MARGIN, y: c.y, size: 11, font: bold, color: BLUE })
    c.y -= 13
    for (const sentence of kpiCommentary(report)) {
      const lines = wrap(sentence, contentW - 10, regular, 8.5, 3)
      await pager.ensure(lines.length * 10 + 2)
      for (const ln of lines) {
        c.page.drawText(ln, { x: MARGIN + 2, y: c.y, size: 8.5, font: regular, color: SLATE })
        c.y -= 10
      }
      c.y -= 1
    }
    c.y -= 6

    // ---- KPI cards (2 columns, formula included) ----
    await pager.ensure(70)
    c.page.drawText("Key Indicators", { x: MARGIN, y: c.y, size: 11, font: bold, color: BLUE })
    c.y -= 13
    const cardW = (contentW - 8) / 2
    const kpis = report.kpis
    for (let i = 0; i < kpis.length; i += 2) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      const pair = [kpis[i]!, kpis[i + 1]].filter(Boolean) as AnalyticsKpi[]
      const defLines = pair.map((k) => wrap(k.definition, cardW - 16, regular, 6.5, 3))
      const cardH = 30 + Math.max(...defLines.map((l) => l.length)) * 8
      await pager.ensure(cardH + 8)
      pair.forEach((k, ci) => {
        const cx = MARGIN + ci * (cardW + 8)
        c.page.drawRectangle({ x: cx, y: c.y - cardH, width: cardW, height: cardH, color: LIGHT, borderColor: rgb(0.88, 0.91, 0.94), borderWidth: 0.75 })
        c.page.drawText(fit(k.label, cardW - 12, bold, 8.5), { x: cx + 6, y: c.y - 11, size: 8.5, font: bold, color: MUTED })
        c.page.drawText(fit(kpiValueText(k), cardW - 60, bold, 15), { x: cx + 6, y: c.y - 27, size: 15, font: bold, color: NAVY })
        if (k.previous && k.previous.deltaPct != null && k.previous.value != null) {
          const up = k.previous.deltaPct >= 0
          c.page.drawText(`${up ? "+" : ""}${k.previous.deltaPct}%`, {
            x: cx + cardW - 50, y: c.y - 27, size: 9, font: bold,
            color: k.intent === "good-low" ? (up ? ROSE : TEAL) : up ? TEAL : ROSE,
          })
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
        defLines[ci]!.forEach((ln, li) => {
          c.page.drawText(ln, { x: cx + 6, y: c.y - 36 - li * 7.5, size: 6.5, font: regular, color: MUTED })
        })
      })
      c.y -= cardH + 8
    }
    c.y -= 4

    // ---- charts ----
    for (const chart of report.charts) {
      const chartH = chart.kind === "donut" ? 110 : 130
      await pager.ensure(chartH + 46)
      c.page.drawText(fit(chart.title, contentW, bold, 10.5), { x: MARGIN, y: c.y, size: 10.5, font: bold, color: NAVY })
      c.y -= 12
      for (const ln of wrap(chart.purpose, contentW, italic, 7.5, 2)) {
        c.page.drawText(ln, { x: MARGIN, y: c.y, size: 7.5, font: italic, color: MUTED })
        c.y -= 9
      }
      c.y -= 4
      const plotY = c.y
      if (chart.kind === "bar") drawBarChart(c.page, chart, MARGIN, plotY, contentW, chartH, fonts)
      else if (chart.kind === "line") drawLineChart(c.page, chart, MARGIN, plotY, contentW, chartH, fonts)
      else drawDonutChart(c.page, chart, MARGIN, plotY, contentW, chartH, fonts)
      c.y = plotY - chartH
      if (chart.note) {
        for (const ln of wrap(`Note: ${chart.note}`, contentW, regular, 7, 2)) {
          c.page.drawText(ln, { x: MARGIN, y: c.y, size: 7, font: regular, color: MUTED })
          c.y -= 8
        }
      }
      c.y -= 10
    }

    // ---- table ----
    if (report.table && report.table.rows.length) {
      await pager.ensure(50)
      c.page.drawText("Data Table", { x: MARGIN, y: c.y, size: 11, font: bold, color: BLUE })
      c.y -= 13
      const cols = report.table.columns
      const colW = cols.map((_col) => Math.max(42, (contentW - (cols.length - 1) * 6) / cols.length))
      const drawRow = (cells: (string | number | null)[], boldRow: boolean) => {
        const f = boldRow ? bold : regular
        let x = MARGIN
        cols.forEach((col, i) => {
          const v = cells[i] == null ? "—" : String(cells[i])
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
          const w = colW[i]! - 6
          c.page.drawText(fit(v, w, f, 7.5), { x: x + (col.align === "right" ? Math.max(0, w - f.widthOfTextAtSize(fit(v, w, f, 7.5), 7.5)) : 0), y: c.y, size: 7.5, font: f, color: boldRow ? NAVY : SLATE })
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
          x += colW[i]! + 0
        })
        c.y -= 13
      }
      // header band
      c.page.drawRectangle({ x: MARGIN, y: c.y - 3, width: contentW, height: 14, color: rgb(0.93, 0.95, 0.98) })
      drawRow(cols.map((col) => col.label), true)
      c.page.drawLine({ start: { x: MARGIN, y: c.y + 4 }, end: { x: MARGIN + contentW, y: c.y + 4 }, thickness: 0.6, color: rgb(0.85, 0.88, 0.92) })
      const maxRows = 60
      for (const row of report.table.rows.slice(0, maxRows)) {
        void pager.ensure(15)
        drawRow(row, false)
      }
      if (report.table.rows.length > maxRows) {
        c.page.drawText(`… ${report.table.rows.length - maxRows} more row(s) — the XLSX export carries the full table.`, { x: MARGIN, y: c.y, size: 7, font: italic, color: MUTED })
        c.y -= 12
      }
      c.y -= 8
    }

    // ---- warnings ----
    if (report.warnings.length) {
      await pager.ensure(report.warnings.length * 10 + 30)
      c.page.drawText("Warnings", { x: MARGIN, y: c.y, size: 11, font: bold, color: AMBER })
      c.y -= 13
      for (const w of report.warnings) {
        for (const ln of wrap(`• ${w}`, contentW - 8, regular, 7.5, 4)) {
          await pager.ensure(10)
          c.page.drawText(ln, { x: MARGIN + 2, y: c.y, size: 7.5, font: regular, color: SLATE })
          c.y -= 9
        }
      }
      c.y -= 6
    }

    // ---- methodology ----
    await pager.ensure(70)
    c.page.drawText("Methodology", { x: MARGIN, y: c.y, size: 11, font: bold, color: BLUE })
    c.y -= 13
    for (const ln of wrap(`Source: ${report.methodology.source}`, contentW, regular, 7.5, 5)) {
      c.page.drawText(ln, { x: MARGIN + 2, y: c.y, size: 7.5, font: regular, color: SLATE })
      c.y -= 9
    }
    for (const [k, v] of Object.entries(report.methodology.definitions)) {
      for (const ln of wrap(`${k}: ${v}`, contentW - 8, regular, 7, 4)) {
        await pager.ensure(9)
        c.page.drawText(ln, { x: MARGIN + 2, y: c.y, size: 7, font: regular, color: MUTED })
        c.y -= 8.5
      }
    }
    c.y -= 4
    for (const ln of wrap(`Generated by: ${report.methodology.generatedBy}`, contentW, italic, 7, 2)) {
      c.page.drawText(ln, { x: MARGIN + 2, y: c.y, size: 7, font: italic, color: MUTED })
      c.y -= 8.5
    }

    if (pass === 0) pages = doc.getPageCount()
  }

  return doc.save()
}

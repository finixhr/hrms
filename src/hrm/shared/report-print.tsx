"use client"
// ============ Wave 3 WP-E — shared report engine (print shell + charts + export) ============
// ONE print/export code path shared by HR Reports AND the Accounting
// statements (Trial Balance / Balance Sheet / Income Statement).
//
// Print layout — Modern ERP SaaS grade, per the Wave 3 spec:
//   [ company identity: logo · name · address · phone · email · BIN/VAT/TIN ]
//   - - - - - - - - - - - - -  dotted separator  - - - - - - - - - - - - - -
//   REPORT NAME (bold) + meta line (period / filters / row count)
//   data table (zebra rows, right-aligned tabular numerics) [+ chart, page 1]
//   - - - - - - - - - - - - -  dotted separator  - - - - - - - - - - - - - -
//   footer: left "Print Date & Time : 10/8/2026 12:10:49PM" · center
//   "Powered by Finix HR" · right "Page X of Y"
//
// Print = IN-APP modal (never a new tab): a portal at document.body renders
// the pages; @media print hides everything else. Multi-page tables paginate
// client-side into fixed-height page blocks so "Page X of Y" is REAL — the
// thead repeats on EVERY page chunk (renderTable is called per page).
//
// Wave 4 print polish (2026-10-08):
//   - rows never split across printed pages (page-break-inside: avoid)
//   - table-layout: fixed + word-break — long Bangla text can no longer blow
//     out a column; numeric (right-aligned) cells keep white-space: nowrap
//   - Bangla-capable font stack on the modal root (Noto Sans Bengali →
//     Hind Siliguri → SolaimanLipi → system-ui) so Bangla names print crisply
import { useMemo, useState } from "react"
import { createPortal } from "react-dom"
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"
import { Download, FileSpreadsheet, FileText, Printer, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// ---------------- print date & time ----------------
/** Exact spec format: "Print Date & Time : 10/8/2026 12:10:49PM"
 *  (M/d/yyyy h:mm:sstt — no space before AM/PM, no leading zeros). */
export function formatPrintDateTime(d: Date): string {
  const h24 = d.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  const ampm = h24 < 12 ? "AM" : "PM"
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h}:${mm}:${ss}${ampm}`
}

export type ReportCompany = {
  companyName?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
  binVatReg?: string | null
  logoUrl?: string | null
}

export type PrintChartSpec = {
  /** recharts data points: [{ label, series1, series2... }] — derived by the caller */
  data: { label: string; [k: string]: string | number }[]
  series: { key: string; name: string }[]
  type: ChartType
}

export type ChartType = "pie" | "donut" | "bar" | "line"

// ---------------- shared print CSS ----------------
const PRINT_CSS_ID = "finix-report-print-css"
/** Bangla-capable fallback stack — applied to the modal root (screen + print,
// inline style) so Bengali names/৳ render identically in preview and paper. */
const PRINT_FONT_STACK = '"Noto Sans Bengali", "Hind Siliguri", "SolaimanLipi", system-ui, sans-serif'
function ensurePrintCss() {
  if (typeof document === "undefined") return
  if (document.getElementById(PRINT_CSS_ID)) return
  const style = document.createElement("style")
  style.id = PRINT_CSS_ID
  style.textContent = `
@media print {
  @page { size: A4 portrait; margin: 10mm 10mm 12mm 10mm; }
  body > *:not(#finix-report-print-root) { display: none !important; }
  body * { -webkit-font-smoothing: antialiased; }
  #finix-report-print-root { position: static !important; inset: auto !important; display: block !important; overflow: visible !important; background: #fff !important; padding: 0 !important; z-index: auto !important; font-family: ${PRINT_FONT_STACK} !important; }
  #finix-report-print-root .rprint-toolbar { display: none !important; }
  #finix-report-print-root .rprint-page { box-shadow: none !important; border: none !important; margin: 0 auto !important; width: 190mm !important; min-height: 250mm; page-break-after: always; break-after: page; }
  #finix-report-print-root .rprint-page:last-child { page-break-after: auto; break-after: auto; }
  #finix-report-print-root .rprint-chart { break-inside: avoid; page-break-inside: avoid; }
  /* Wave 4 — a row never straddles two printed pages */
  #finix-report-print-root tr { page-break-inside: avoid; break-inside: avoid; }
  /* Wave 4 — fixed layout + word-break stop long Bangla text from blowing
     out a column (the header row repeats per page chunk in the DOM) */
  #finix-report-print-root table { table-layout: fixed; }
  #finix-report-print-root th, #finix-report-print-root td { word-break: break-word; overflow-wrap: anywhere; }
}
`
  document.head.appendChild(style)
}

// ---------------- chart panel (screen) ----------------
const CHART_COLORS = ["#059669", "#0ea5e9", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#64748b", "#d946ef", "#84cc16", "#e11d48", "#0891b2"]

/** Generic chart renderer for { data, series, type } specs (recharts). */
export function ReportChart({ spec, height = 260 }: { spec: PrintChartSpec; height?: number }) {
  if (!spec.data.length) return null
  const numeric = (v: string | number) => typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, "")) || 0
  if (spec.type === "pie" || spec.type === "donut") {
    const only = spec.series[0]
    const data = spec.data.map((d) => ({ name: d.label, value: Math.abs(numeric(d[only?.key || ""])) })).filter((x) => x.value > 0)
    if (!data.length) return null
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={spec.type === "donut" ? "55%" : 0} outerRadius="85%" paddingAngle={1} isAnimationActive={false}>
            {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip formatter={(v: any, n: any) => [v, n]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    )
  }
  if (spec.type === "line") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={spec.data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} width={48} />
          <Tooltip />
          {spec.series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {spec.series.map((s, i) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={spec.data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={spec.data.length > 7 ? -25 : 0} textAnchor={spec.data.length > 7 ? "end" : "middle"} height={spec.data.length > 7 ? 46 : 24} />
        <YAxis tick={{ fontSize: 10 }} width={48} />
        <Tooltip />
        {spec.series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {spec.series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ---------------- export-as menu ----------------
/** "Export as" split-button: .xlsx (SheetJS, client-side from the RENDERED
 *  rows — Bengali/৳-safe) and .csv (existing server CSV path, UTF-8 BOM).
 *  RPT-002 (Wave R3-3): xlsxHidden removes the .xlsx item entirely — used for
 *  PII-class reports when the caller lacks reports.pii (the client-side
 *  sheet would otherwise bypass the server's bulk-PII gate). */
export function ExportAsMenu({ onCsv, getXlsxData, disabled, fileBase, xlsxHidden }: {
  onCsv: () => void
  getXlsxData: () => { columns: string[]; rows: (string | number | null)[][] }
  disabled?: boolean
  fileBase: string
  xlsxHidden?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const xlsx = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { columns, rows } = getXlsxData()
      await exportFileXlsx(columns, rows, fileBase)
    } catch (e: any) {
      console.error("xlsx export failed", e)
    } finally { setBusy(false) }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" disabled={disabled || busy}>
          <Download className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Export as
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {!xlsxHidden && (
          <DropdownMenuItem className="text-xs" onSelect={() => { void xlsx() }}>
            <FileSpreadsheet className="h-3.5 w-3.5 mr-2 text-emerald-600" /> Export as .xlsx
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="text-xs" onSelect={onCsv}>
          <FileText className="h-3.5 w-3.5 mr-2 text-sky-600" /> Export as .csv
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export async function exportFileXlsx(columns: string[], rows: (string | number | null)[][], fileBase: string) {
  const XLSX = await import("xlsx")
  const aoa: unknown[][] = [columns, ...rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : c)))]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // sane column widths so wide registers stay readable
  const widths = columns.map((c, i) => ({
    wch: Math.min(42, Math.max(10, String(c).length + 2, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length + 2))),
  }))
  ws["!cols"] = widths
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Report")
  XLSX.writeFile(wb, `${fileBase}.xlsx`)
}

/** Client-side CSV (UTF-8 BOM, Excel-safe quoting) — used by the Accounting
 *  statements, which have no server CSV twin. */
export function exportFileCsv(columns: string[], rows: (string | number | null)[][], fileBase: string) {
  const escCsv = (v: unknown) => {
    let s = String(v ?? "")
    // V5-002 — formula injection guard: prefix cells starting with a spreadsheet
    // operator so Excel/Sheets renders them as text and never executes them.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [columns, ...rows].map((r) => r.map(escCsv).join(",")).join("\r\n")
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${fileBase}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------- the print modal (in-app, never a new tab) ----------------
export type PrintPayload = {
  company: ReportCompany
  title: string
  meta: string
  columns: string[]
  numericCols: Record<number, boolean>
  rows: (string | number | null)[][]
  chart?: PrintChartSpec | null
  totalsRow?: (string | number | null)[] | null
  /** rows per printed page (default 24; page 1 carries fewer when a chart prints) */
  rowsPerPage?: number
}

const escHtml = (v: unknown): string =>
  String(v ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function ReportPrintModal({ payload, onClose }: { payload: PrintPayload | null; onClose: () => void }) {
  const [printedAt, setPrintedAt] = useState<Date | null>(null)
  useMemo(() => { ensurePrintCss() }, [])

  if (!payload || typeof document === "undefined") return null

  const rowsPerPage = payload.rowsPerPage ?? 24
  const firstPageRows = payload.chart ? Math.max(4, rowsPerPage - 12) : rowsPerPage
  const pages: (string | number | null)[][][] = []
  if (payload.rows.length) {
    let rest = payload.rows
    pages.push(rest.slice(0, firstPageRows))
    rest = rest.slice(firstPageRows)
    while (rest.length) { pages.push(rest.slice(0, rowsPerPage)); rest = rest.slice(rowsPerPage) }
  } else {
    pages.push([]) // one page with the header + "no rows" note
  }
  const stamp = printedAt ?? new Date()
  const stampLabel = formatPrintDateTime(stamp)

  const doPrint = () => {
    // refresh the timestamp LIVE at print time, wait two frames so the DOM
    // carries the new value before the print dialog snapshots it
    setPrintedAt(new Date())
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }

  const company = payload.company || {}
  const companyName = company.companyName || "My Company Ltd."

  const renderTable = (chunk: (string | number | null)[][], isLast: boolean) => (
    <table className="w-full border-collapse">
      {/* the header row is rendered for EVERY page chunk — on paper each
          paginated page carries its own column headers */}
      <thead>
        <tr>
          {payload.columns.map((c, i) => (
            <th key={i} className="bg-slate-50 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600"
              style={{ borderBottom: "1.5px solid #059669", textAlign: payload.numericCols[i] ? "right" : "left", whiteSpace: payload.numericCols[i] ? "nowrap" : undefined }}>
              {escHtml(c)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {chunk.length === 0 && (
          <tr><td className="px-2 py-4 text-center text-[11px] text-slate-400" colSpan={payload.columns.length}>No rows for the selected filters.</td></tr>
        )}
        {chunk.map((r, ri) => (
          <tr key={ri} className={ri % 2 === 1 ? "bg-slate-50/70" : ""}>
            {r.map((cell, ci) => (
              <td key={ci} className="border-b border-slate-200 px-2 py-1 text-[10.5px] text-slate-700"
                style={{ textAlign: payload.numericCols[ci] ? "right" : "left", fontVariantNumeric: payload.numericCols[ci] ? "tabular-nums" : undefined, whiteSpace: payload.numericCols[ci] ? "nowrap" : undefined }}>
                {escHtml(cell)}
              </td>
            ))}
          </tr>
        ))}
        {isLast && payload.totalsRow && (
          <tr>
            {payload.totalsRow.map((cell, ci) => (
              <td key={ci} className="border-y-[1.5px] border-slate-400 bg-slate-100 px-2 py-1.5 text-[10.5px] font-bold text-slate-800"
                style={{ textAlign: payload.numericCols[ci] ? "right" : "left", fontVariantNumeric: payload.numericCols[ci] ? "tabular-nums" : undefined, whiteSpace: payload.numericCols[ci] ? "nowrap" : undefined }}>
                {escHtml(cell)}
              </td>
            ))}
          </tr>
        )}
      </tbody>
    </table>
  )

  const renderPage = (chunk: (string | number | null)[][], pageIndex: number, total: number, isLast: boolean) => (
    <div key={pageIndex} className="rprint-page mx-auto flex w-[190mm] min-h-[250mm] flex-col bg-white px-0 py-0 shadow-lg outline outline-1 outline-slate-200">
      {/* ---- header: company identity + dotted separator ---- */}
      <div className="flex items-start justify-between gap-4 pb-2" style={{ borderBottom: "1.5px dotted #94a3b8" }}>
        <div className="flex items-center gap-3">
          {company.logoUrl ? (
            <img src={company.logoUrl} alt="" className="h-12 w-12 rounded object-contain" />
          ) : null}
          <div>
            <p className="text-[15px] font-bold leading-tight text-slate-900">{escHtml(companyName)}</p>
            {company.address ? <p className="text-[9.5px] leading-snug text-slate-500">{escHtml(company.address)}</p> : null}
            <p className="text-[9.5px] leading-snug text-slate-500">
              {[company.phone, company.email].filter(Boolean).map(escHtml).join(" · ")}
            </p>
            {company.binVatReg ? <p className="text-[9.5px] leading-snug text-slate-500">BIN/VAT/TIN: {escHtml(company.binVatReg)}</p> : null}
          </div>
        </div>
        <p className="shrink-0 pt-1 text-[9px] font-semibold uppercase tracking-widest text-emerald-700">HRM Report</p>
      </div>

      {/* ---- report name + meta ---- */}
      <div className="pt-2 pb-1.5">
        <p className="text-[13px] font-bold text-slate-900">{escHtml(payload.title)}</p>
        <p className="text-[9.5px] text-slate-500">{escHtml(payload.meta)}{pageIndex === 0 ? "" : " (continued)"}</p>
      </div>

      {/* ---- chart on page 1 ---- */}
      {pageIndex === 0 && payload.chart && payload.chart.data.length > 0 && (
        <div className="rprint-chart mb-2 rounded border border-slate-200 bg-slate-50/50 p-2">
          <div style={{ height: 210 }}>
            <ReportChart spec={payload.chart} height={210} />
          </div>
        </div>
      )}

      {/* ---- table ---- */}
      <div className="flex-1">{renderTable(chunk, isLast)}</div>

      {/* ---- dotted separator + footer ---- */}
      <div className="mt-2 flex items-center justify-between gap-3 pt-1.5 text-[8.5px] text-slate-600" style={{ borderTop: "1.5px dotted #94a3b8" }}>
        <span>Print Date &amp; Time : {stampLabel}</span>
        <span className="font-medium">Powered by Finix HR</span>
        <span>Page {pageIndex + 1} of {total}</span>
      </div>
    </div>
  )

  return createPortal(
    <div id="finix-report-print-root" className="fixed inset-0 z-[100] overflow-y-auto bg-slate-900/70 p-4 sm:p-6" style={{ fontFamily: PRINT_FONT_STACK }}>
      {/* toolbar (screen only — hidden by the print CSS) */}
      <div className="rprint-toolbar sticky top-0 z-10 mx-auto mb-4 flex w-[190mm] max-w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">{payload.title}</p>
          <p className="text-[11px] text-slate-500">{pages.length} printed page{pages.length === 1 ? "" : "s"} · {payload.rows.length} row{payload.rows.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" className="h-8 text-xs" onClick={doPrint}>
            <Printer className="mr-1 h-3.5 w-3.5" /> Print
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onClose}>
            <X className="mr-1 h-3.5 w-3.5" /> Close
          </Button>
        </div>
      </div>
      <div className="flex flex-col items-center gap-6 pb-8">
        {pages.map((chunk, i) => renderPage(chunk, i, pages.length, i === pages.length - 1))}
      </div>
    </div>,
    document.body,
  )
}

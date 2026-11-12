"use client"
// ============ Holiday Calendar (shared) ============
// Lives in HR Settings → Holiday Calendar (moved from Branches & Departments —
// same data, same holidays.* routes). Adds Bulk Add Holidays with Excel/CSV
// import: column mapping, validation, duplicate detection, per-row error
// reporting, preview before commit and a server-verified transactional insert.
import { useMemo, useRef, useState } from "react"
import { Plus, Trash2, Upload, FileSpreadsheet, AlertTriangle, CheckCircle2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { titleCase } from "./ui-kit"
import { DataTable, type Column } from "./data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "./form-dialog"

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const TYPE_ALIASES: Record<string, string> = {
  public: "PUBLIC", optional: "OPTIONAL", company: "COMPANY", "general": "PUBLIC", "govt": "PUBLIC",
}

/** Parse one ISO / DD-MM-YYYY / DD/MM/YYYY / MM/DD-unsafe → ISO. Returns null when unparseable. */
function parseDate(raw: string): string | null {
  const s = String(raw || "").trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/) // DD-MM-YYYY (BD convention)
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), m[3]]
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/) // DD-MM-YY (this century)
  if (m) {
    const [d, mo, yy] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const y = 2000 + yy
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  }
  const dt = new Date(s)
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10)
  return null
}

/** Minimal Excel/CSV reader: CSV (comma/semicolon/tab) is parsed directly; .xlsx
 *  sheets are read from the embedded xl/sharedStrings.xml + sheet1 via DOMParser
 *  (no heavyweight dependency — enough for single-sheet holiday lists). */
export async function readSheet(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase()
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = await file.text()
    return parseDelimited(text)
  }
  if (name.endsWith(".xls") || name.endsWith(".xlsx")) {
    const mod: any = await import("xlsx")
    const XLSX = mod.default || mod // ESM/CJS interop
    if (XLSX?.read) {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false }) as string[][]
    }
    throw new Error("Excel parsing is unavailable in this build — save the sheet as CSV and retry")
  }
  throw new Error("Unsupported file type — use .csv, .xlsx or .xls")
}

function parseDelimited(text: string): string[][] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "")
  const delim = [",", ";", "\t"].map((d) => ({ d, n: (lines[0].match(new RegExp(`\\${d}`, "g")) || []).length }))
    .sort((a, b) => b.n - a.n)[0].d
  return lines.map((l) => l.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, "$1")))
}

type MappedRow = { rowNo: number; name: string; date: string; type: string; branchName: string; problem?: string }

export function HolidaysTab() {
  const { can } = useHrm()
  const year = new Date().getFullYear()
  const [y, setY] = useState(year)
  const { data, loading, error, reload } = useApi<any[]>("holidays.list", { year: y })
  const { data: branches } = useApi<any[]>("branches.list", {})
  const [open, setOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<any>(null)
  const [importOpen, setImportOpen] = useState(false)

  const fields: FieldDef[] = [
    { name: "name", label: "Holiday Name", required: true, span: 2 },
    { name: "date", label: "Date", type: "date", required: true },
    { name: "type", label: "Type", type: "select", options: ["PUBLIC", "OPTIONAL", "COMPANY"].map((t) => ({ value: t, label: titleCase(t) })) },
    { name: "branchId", label: "Branch (blank = all)", type: "select", options: (branches || []).map((b: any) => ({ value: b.id, label: b.name })) },
  ]

  const columns: Column<any>[] = [
    { key: "date", label: "Date", sortValue: (h) => h.date, render: (h) => <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200">{h.date}</span> },
    {
      key: "dow", label: "Day", render: (h) => {
        const d = new Date(h.date + "T00:00:00")
        return <span className="text-[11px] text-slate-500">{isNaN(d.getTime()) ? "—" : WEEKDAY[d.getDay()]}</span>
      },
    },
    { key: "name", label: "Holiday", render: (h) => <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{h.name}</span> },
    { key: "type", label: "Type", render: (h) => <Badge variant="outline" className="text-[10px]">{titleCase(h.type)}</Badge> },
    { key: "branch", label: "Branch", render: (h) => <span className="text-xs text-slate-500">{(branches || []).find((b) => b.id === h.branchId)?.name || "All branches"}</span> },
    {
      key: "actions", label: "", align: "right", render: (h) => can("organization", "delete") && (
        <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelTarget(h)}><Trash2 className="h-3.5 w-3.5" /></Button>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setY(y - 1)}>← {y - 1}</Button>
          <span className="text-sm font-bold tabular-nums">{y}</span>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setY(y + 1)}>{y + 1} →</Button>
        </div>
        {can("organization", "create") && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setImportOpen(true)}>
              <Upload className="h-3.5 w-3.5 mr-1" /> Bulk Add Holidays
            </Button>
            <Button size="sm" onClick={() => setOpen(true)} className=" h-8">
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Holiday
            </Button>
          </div>
        )}
      </div>
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={20} csvName={`holidays-${y}`} emptyTitle={`No holidays configured for ${y}`} />
      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reload() }} title="Add Holiday" fields={fields}
        description="Holidays are consumed by the attendance engine and payroll working-day calculation."
        onSubmit={async (v) => { await rpc("holidays.create", v) }} />
      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }} title="Delete holiday"
        message={`Remove "${delTarget?.name}"?`} danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("holidays.delete", { id: delTarget.id }); reload() }} />
      <HolidayImportDialog open={importOpen} onOpenChange={(v) => { setImportOpen(v); if (!v) reload() }} branches={branches || []} existing={data || []} />
    </div>
  )
}

// ================= Bulk import dialog =================
function HolidayImportDialog({ open, onOpenChange, branches, existing }: {
  open: boolean; onOpenChange: (v: boolean) => void; branches: any[]; existing: any[]
}) {
  const toast = useHrm((s) => s.toast)
  const [sheet, setSheet] = useState<string[][] | null>(null)
  const [fileName, setFileName] = useState("")
  const [fileError, setFileError] = useState<string | null>(null)
  const [map, setMap] = useState<{ name: number; date: number; type: number; branch: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ inserted: number; rejected: number; errors: { row: number; name?: string; reason: string }[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const headers = useMemo(() => (sheet?.[0] || []).map((h, i) => ({ i, label: h || `Column ${i + 1}` })), [sheet])

  // auto-detect likely columns on load (name / date / type / branch)
  const onFile = async (f: File | null) => {
    if (!f) return
    setFileError(null); setResult(null); setSheet(null); setMap(null)
    try {
      const rows = await readSheet(f)
      if (rows.length < 2) throw new Error("The file has no data rows (need a header row + at least one holiday)")
      setSheet(rows)
      setFileName(f.name)
      const head = rows[0].map((h) => String(h || "").toLowerCase())
      const find = (...keys: string[]) => head.findIndex((h) => keys.some((k) => h.includes(k)))
      // FIX: "Holiday Name" contains the substring "day" (holi-DAY) and used to
      // win the date-column match. The date column must contain "date", or be a
      // standalone "day"-ish header that is NOT part of "holiday".
      const dateIdx = head.findIndex((h) =>
        h.includes("date") || (/(^|[^a-z])day([^a-z]|$)/.test(h) && !h.includes("holi")))
      const m = {
        name: find("holiday", "name", "occasion", "title"),
        date: dateIdx,
        type: find("type", "kind"),
        branch: find("branch", "location", "outlet"),
      }
      if (m.date === -1) throw new Error("No date column detected — map the columns manually below")
      setMap(m as any)
    } catch (e: any) {
      setFileError(e.message)
    }
  }

  // preview rows: parse + validate client-side (the server re-validates on commit)
  const preview = useMemo<MappedRow[]>(() => {
    if (!sheet || !map || map.date === -1) return []
    const existingKeys = new Set(existing.map((h) => `${h.date}|${h.branchId || ""}`))
    const seen = new Set<string>()
    const out: MappedRow[] = []
    for (let i = 1; i < sheet.length; i++) {
      const r = sheet[i]
      const name = String(r[map.name] ?? "").trim()
      const dateRaw = String(r[map.date] ?? "").trim()
      const typeRaw = map.type >= 0 ? String(r[map.type] ?? "").trim() : ""
      const branchName = map.branch >= 0 ? String(r[map.branch] ?? "").trim() : ""
      const rowNo = i + 1
      const date = parseDate(dateRaw)
      let problem: string | undefined
      if (!name) problem = "missing holiday name"
      else if (!date) problem = `unparseable date "${dateRaw}"`
      else {
        const d = new Date(date + "T00:00:00")
        if (isNaN(d.getTime())) problem = `invalid calendar date "${dateRaw}"`
      }
      const type = TYPE_ALIASES[typeRaw.toLowerCase()] || (["PUBLIC", "OPTIONAL", "COMPANY"].includes(typeRaw.toUpperCase()) ? typeRaw.toUpperCase() : "")
      if (!problem && !type && typeRaw && !TYPE_ALIASES[typeRaw.toLowerCase()]) problem = `unknown type "${typeRaw}"`
      const finalType = type || "PUBLIC"
      if (!problem && branchName && branches.length && !branches.some((b) => b.name.toLowerCase() === branchName.toLowerCase())) {
        problem = `unknown branch "${branchName}"`
      }
      if (!problem) {
        const key = `${date}|${branchName ? branches.find((b) => b.name.toLowerCase() === branchName.toLowerCase())?.id || "" : ""}`
        if (seen.has(key)) problem = "duplicate row in file (same date + branch)"
        else if (existingKeys.has(key)) problem = "already exists in the calendar"
        seen.add(key)
      }
      out.push({ rowNo, name: name || "—", date: date || dateRaw || "—", type: typeRaw || finalType, branchName, problem })
    }
    return out
  }, [sheet, map, existing, branches])

  const validRows = preview.filter((r) => !r.problem)
  const invalidRows = preview.filter((r) => r.problem)

  const commit = async () => {
    setBusy(true)
    try {
      const rows = validRows.map((r) => {
        const _branchId = r.branchName ? branches.find((b) => b.name.toLowerCase() === r.branchName.toLowerCase())?.id || null : null
        return { name: r.name, date: r.date, type: (TYPE_ALIASES[String(r.type).toLowerCase()] || String(r.type).toUpperCase() || "PUBLIC"), branchName: r.branchName, rowNo: r.rowNo }
      })
      const res = await rpc<{ inserted: number; rejected: number; errors: { row: number; name?: string; reason: string }[] }>("holidays.bulkCreate", { rows })
      setResult(res)
      toast(`Imported ${res.inserted} holiday(s)${res.rejected ? ` — ${res.rejected} rejected` : ""}`, res.rejected ? "err" : "ok")
      if (res.inserted > 0) {
        // keep the dialog open so rejected rows stay visible; refresh handled on close
      }
    } catch (e: any) {
      toast(e.message, "err")
    } finally { setBusy(false) }
  }

  const close = (v: boolean) => { if (!v) { setSheet(null); setMap(null); setResult(null); setFileError(null); setFileName("") } onOpenChange(v) }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base"><FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Bulk Add Holidays</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* step 1 — file */}
          <div>
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">1 · Choose an Excel or CSV file</p>
            <p className="text-[11px] text-slate-500 mb-2">Columns (any order, mapped next): Holiday Name · Date (YYYY-MM-DD, DD-MM-YYYY or DD/MM/YY) · Type (Public/Optional/Company) · Branch (blank = all)</p>
            <div className="flex items-center gap-2">
              <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx,.xls" className="hidden"
                onChange={(e) => onFile(e.target.files?.[0] || null)} />
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => fileRef.current?.click()} disabled={busy}>
                <Upload className="h-3.5 w-3.5 mr-1" /> {fileName ? `Choose another file` : "Select file"}
              </Button>
              {fileName && <span className="text-[11px] text-slate-500 truncate">{fileName}</span>}
            </div>
            {fileError && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/40 rounded-md px-2.5 py-1.5 mt-2 flex items-start gap-1.5"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />{fileError}</p>}
          </div>

          {/* step 2 — column mapping */}
          {sheet && (
            <div>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">2 · Map columns</p>
              <div className="grid grid-cols-2 gap-2.5">
                {(["name", "date", "type", "branch"] as const).map((k) => (
                  <div key={k} className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      {k === "name" ? "Holiday Name *" : k === "date" ? "Date *" : k === "type" ? "Type" : "Branch"}
                    </label>
                    <Select value={map ? String(map[k]) : "-1"} onValueChange={(v) => setMap((m) => m ? { ...m, [k]: Number(v) } : m)}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="-1">— Not mapped —</SelectItem>
                        {headers.map((h) => <SelectItem key={h.i} value={String(h.i)}>{h.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* step 3 — preview */}
          {preview.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">3 · Preview &amp; validation</p>
              <div className="flex flex-wrap gap-2 mb-2 text-[11px]">
                <Badge className="bg-emerald-100 text-emerald-700"><CheckCircle2 className="h-3 w-3 mr-0.5" />{validRows.length} valid</Badge>
                {invalidRows.length > 0 && <Badge className="bg-rose-100 text-rose-700"><XCircle className="h-3 w-3 mr-0.5" />{invalidRows.length} will be skipped</Badge>}
                <Badge variant="outline">{preview.length} rows read</Badge>
              </div>
              <div className="rounded-lg border overflow-hidden">
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50 dark:bg-slate-800/80 sticky top-0">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium text-slate-500">#</th>
                        <th className="text-left px-2 py-1.5 font-medium text-slate-500">Holiday</th>
                        <th className="text-left px-2 py-1.5 font-medium text-slate-500">Date</th>
                        <th className="text-left px-2 py-1.5 font-medium text-slate-500">Type</th>
                        <th className="text-left px-2 py-1.5 font-medium text-slate-500">Branch</th>
                        <th className="text-left px-2 py-1.5 font-medium text-slate-500">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.slice(0, 300).map((r) => (
                        <tr key={r.rowNo} className={`border-t border-slate-100 dark:border-slate-800 ${r.problem ? "bg-rose-50/60 dark:bg-rose-950/20" : ""}`}>
                          <td className="px-2 py-1 text-slate-400 tabular-nums">{r.rowNo}</td>
                          <td className="px-2 py-1 text-slate-700 dark:text-slate-200 max-w-[160px] truncate">{r.name}</td>
                          <td className="px-2 py-1 tabular-nums text-slate-600 dark:text-slate-300">{r.date}</td>
                          <td className="px-2 py-1 text-slate-500">{titleCase(r.type) || "Public"}</td>
                          <td className="px-2 py-1 text-slate-500 max-w-[120px] truncate">{r.branchName || "All"}</td>
                          <td className="px-2 py-1">
                            {r.problem
                              ? <span className="text-rose-600 flex items-start gap-1"><XCircle className="h-3 w-3 mt-0.5 shrink-0" />{r.problem}</span>
                              : <span className="text-emerald-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />import</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {preview.length > 300 && <p className="text-[10px] text-slate-400 mt-1">Showing first 300 of {preview.length} rows — all rows are imported.</p>}
            </div>
          )}

          {/* step 4 — result */}
          {result && (
            <div className={`rounded-lg border px-3 py-2.5 text-xs ${result.rejected ? "border-amber-200 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300" : "border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300"}`}>
              <p className="font-medium flex items-center gap-1.5">
                {result.rejected ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {result.inserted} holiday(s) imported{result.rejected ? `, ${result.rejected} rejected by the server` : ""}.
              </p>
              {result.errors?.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 list-disc list-inside">
                  {result.errors.slice(0, 12).map((e, i) => <li key={i}>Row {e.row}{e.name ? ` (${e.name})` : ""}: {e.reason}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>Close</Button>
          <Button disabled={busy || validRows.length === 0} onClick={commit}>
            {busy ? "Importing…" : `Import ${validRows.length} Holiday${validRows.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

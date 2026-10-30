"use client"
// ============ DataTable — the workhorse table used by every module view ============
// 2026 redesign: compact scannable rows, refined toolbar, optional sticky
// header (scrolling container), elegant sort states and pagination. The props
// contract is unchanged — every existing call-site keeps working.
import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, ArrowUp, Download, Search, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { EmptyState, LoadingRows } from "./ui-kit"

export type Column<T> = {
  key: string
  label: string
  render?: (row: T) => React.ReactNode
  align?: "left" | "right" | "center"
  sortValue?: (row: T) => string | number
  // Search-only text for columns whose meaningful content lives in a custom
  // `render` (e.g. the Employee column shows "Name" + "CODE · designation"
  // but sorts by name alone). When present, it takes precedence over
  // sortValue/raw-key matching so composite cells become searchable.
  searchValue?: (row: T) => string
  csvValue?: (row: T) => string | number | null | undefined
  exportable?: boolean
  className?: string
}

export function DataTable<T extends Record<string, any>>({
  columns, rows, loading, error, searchable = true, searchPlaceholder, pageSize = 15,
  toolbar, emptyTitle = "No records found", emptyHint, onRowClick, csvName, dense, onSearch, stickyHeader,
  exportColumns, onExportCsv,
}: {
  columns: Column<T>[]; rows: T[] | undefined; loading?: boolean; error?: string | null
  searchable?: boolean; searchPlaceholder?: string; pageSize?: number
  toolbar?: React.ReactNode; emptyTitle?: string; emptyHint?: string
  onRowClick?: (row: T) => void; csvName?: string; dense?: boolean
  /** Server-side search: when provided, keystrokes are debounced up to the
   * parent (which reloads rows already filtered by the server) and local
   * filtering is skipped — so matches beyond the currently loaded page are
   * still found (e.g. the Employee Directory's server-paginated 200-row pages). */
  onSearch?: (q: string) => void
  /** 2026 redesign — freeze the header row inside a vertically scrolling
   * container (~viewport height) so long lists stay labeled. Opt-in so
   * existing layouts/print flows are unaffected. */
  stickyHeader?: boolean
  /** Custom export columns to provide richer/separate columns in CSV/Excel export */
  exportColumns?: Column<T>[]
  /** Custom CSV export handler */
  onExportCsv?: (rows: T[]) => void
}) {
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)

  // Debounce keystrokes to the parent for server-side filtering. The callback
  // is read through a ref so parents can pass inline closures without
  // re-triggering the timer on every render; clearing the query resets
  // immediately instead of waiting out the debounce.
  const onSearchRef = useRef(onSearch)
  // keep the ref in sync OUTSIDE of render (react-hooks/refs): assigning
  // .current during render is unsafe under concurrent rendering
  useEffect(() => {
    onSearchRef.current = onSearch
  }, [onSearch])
  // first-render guard: the mount pass must NOT echo an empty query up to the
  // parent. On remount (e.g. a view switch) a spurious onSearch("") used to
  // restart the parent's load loop and, before the shell stayed mounted, wipe
  // the query state — half of the directory search focus-loss bug.
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!onSearchRef.current) return
    if (!mountedRef.current) { mountedRef.current = true; return }
    const t = setTimeout(() => onSearchRef.current?.(q), q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q])

  const filtered = useMemo(() => {
    let out = rows || []
    // Server-side search mode: rows arrive pre-filtered — no local matching.
    if (q && !onSearch) {
      const needle = q.toLowerCase()
      out = out.filter((r) =>
        columns.some((c) => {
          const v = c.searchValue ? c.searchValue(r) : c.sortValue ? c.sortValue(r) : r[c.key]
          return String(v ?? "").toLowerCase().includes(needle)
        })
      )
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key)
      out = [...out].sort((a, b) => {
        const av = col?.sortValue ? col.sortValue(a) : a[sort.key]
        const bv = col?.sortValue ? col.sortValue(b) : b[sort.key]
        const an = typeof av === "number" ? av : String(av ?? "")
        const bn = typeof bv === "number" ? bv : String(bv ?? "")
        if (an < bn) return -1 * sort.dir
        if (an > bn) return 1 * sort.dir
        return 0
      })
    }
    return out
  }, [rows, q, sort, columns, onSearch])

  // The live search box — rendered both in the normal toolbar and in the
  // empty-state header. In server-search mode a query that matches nothing
  // leaves rows empty, so the input MUST stay editable there or the user
  // could never correct a typo (the old disabled placeholder locked them out).
  const searchBox = searchable ? (
    <div className="relative flex-1 min-w-[170px] max-w-xs">
      <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder={searchPlaceholder || "Search…"}
        aria-label={searchPlaceholder || "Search table"} className="pl-8 h-8" />
    </div>
  ) : null

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pages)
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  const exportCsv = () => {
    if (onExportCsv) {
      onExportCsv(filtered)
      return
    }
    const cols = (exportColumns || columns).filter(
      (c) => c.exportable !== false && c.key !== "actions" && (c.label || "").trim() !== ""
    )
    // M-8 — neutralize spreadsheet formula prefixes (=, +, -, @) so exported
    // CSV cells render as text in Excel/Sheets instead of executing as formulas.
    const guard = (s: string) => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s)
    const header = cols.map((c) => `"${guard(c.label)}"`).join(",")
    const lines = filtered.map((r) =>
      cols.map((c) => {
        const v = c.csvValue ? c.csvValue(r) : c.sortValue ? c.sortValue(r) : r[c.key]
        const s0 = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)
        const s = guard(s0)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }).join(",")
    )
    const blob = new Blob(["\uFEFF" + [header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = (csvName || "export") + ".csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  // 2026-10 fix — the search box (and toolbar) NEVER unmount. The previous
  // early returns (`if (loading) return <LoadingRows/>`, empty-state and error
  // replacements of the whole card) destroyed the <input> on every search-driven
  // reload: the user typed one character, the debounced server search fired,
  // the table swapped to a loading skeleton, and the remounted input came back
  // EMPTY and unfocused — so focus was lost after every keystroke and the
  // mount echo re-fired onSearch(""). Only the table BODY swaps states now;
  // the toolbar element identity (and therefore DOM focus + the query state)
  // survives reloads, empty results and errors alike.
  const showLoading = loading && (!rows || rows.length === 0)
  const showEmpty = !loading && !error && (!rows || rows.length === 0)

  return (
    <div className="rounded-xl border bg-card overflow-hidden hrm-shadow-xs">
      {(toolbar || searchable || csvName) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b bg-muted/30">
          {searchBox || <div className="flex-1" />}
          <div className="flex items-center gap-1.5">
            {toolbar}
            {csvName && (
              <Button variant="outline" size="sm" onClick={exportCsv} className="h-8" aria-label="Export visible rows as CSV" title="Export visible rows as CSV">
                <Download className="h-3.5 w-3.5" aria-hidden="true" /> CSV
              </Button>
            )}
          </div>
        </div>
      )}
      {error ? (
        <div className="p-4 text-sm text-rose-700 dark:text-rose-300">{error}</div>
      ) : showLoading ? (
        <LoadingRows />
      ) : showEmpty ? (
        <EmptyState title={emptyTitle} hint={emptyHint} />
      ) : (
        <div
          className={cn("overflow-auto scroll-thin", stickyHeader && "max-h-[calc(100vh-320px)] min-h-[240px]")}
          style={stickyHeader ? { overscrollBehavior: "contain" } : undefined}
        >
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50 border-b">
                {columns.map((c) => (
                  <TableHead key={c.key}
                    // M-9 — sort state exposed to assistive tech
                    aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                    className={cn(
                      "sticky-header-cell text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap bg-muted/50 backdrop-blur",
                      stickyHeader && "sticky top-0 z-10",
                      c.align === "right" && "text-right", c.align === "center" && "text-center",
                    )}>
                    <button
                      aria-label={`${c.label}${sort?.key === c.key ? (sort.dir === 1 ? " — sorted ascending" : " — sorted descending") : " — activate to sort"}`}
                      className={cn("inline-flex items-center gap-1 rounded hover:text-foreground transition-colors", (c.sortValue || true) && "")} onClick={() => setSort((s) => s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 })}>
                      {c.label}
                      {sort?.key === c.key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3 text-primary" /> : <ArrowDown className="h-3 w-3 text-primary" />)}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((row, i) => (
                <TableRow
                  key={row.id || i}
                  // M-9 — keyboard-activatable rows: focusable + Enter/Space
                  // triggers onRowClick, parity with the click path
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick ? (e) => {
                    if (e.key !== "Enter" && e.key !== " ") return
                    // 2026-10-13 — portal guard (see onClick below): keys pressed
                    // inside a row-mounted dialog/select popover must not activate
                    // the row behind it
                    if (e.target !== e.currentTarget) return
                    e.preventDefault(); onRowClick(row)
                  } : undefined}
                  className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset", onRowClick && "cursor-pointer", loading && "opacity-60")}
                  // 2026-10-13 — portal containment guard: dialogs, dropdowns,
                  // popovers and selects rendered by row cells are portaled to
                  // document.body by Radix, but React synthetic events STILL
                  // bubble through the React tree into this <tr>. Without the
                  // DOM-containment check, clicking ANY interactive control
                  // inside such a dialog (e.g. the Attendance History date
                  // picker opened from the Employee Action menu) fires the row
                  // click, instantly closing the modal and opening the profile
                  // behind it. A genuine in-row click always has its target
                  // inside the <tr>; a portal-dispatched one never does.
                  onClick={onRowClick ? (e) => {
                    if (e.target instanceof Node && !e.currentTarget.contains(e.target)) return
                    onRowClick(row)
                  } : undefined}>
                  {columns.map((c) => (
                    <TableCell key={c.key} className={cn(dense ? "py-1" : "py-1.5", "text-[13px]", c.align === "right" && "text-right tabular-nums", c.align === "center" && "text-center", c.className)}>
                      {c.render ? c.render(row) : (row[c.key] ?? "—")}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {!error && !showLoading && !showEmpty && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 h-9 border-t bg-muted/30 text-xs text-muted-foreground">
          <span className="tabular-nums">{filtered.length} record{filtered.length !== 1 ? "s" : ""}{loading && " · searching…"}</span>
          {pages > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="px-1.5 tabular-nums font-medium">{safePage} / {pages}</span>
              <Button variant="outline" size="icon-sm" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)} aria-label="Next page">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

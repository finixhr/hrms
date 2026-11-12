"use client"
// ============ Customizable widget dashboard — grid engine ============
// Renders the user's widget layout on a 12-column grid. Edit mode provides:
//   - drag & drop reordering (HTML5 DnD, grid-aware before/after insertion)
//   - pointer-drag resizing — horizontally (column snap) AND vertically
//     (row snap, 2026-10 expansion: feed widgets can merge 2-3 grid rows)
//   - add / remove widgets from the gated widget library
//   - Save / Cancel / Reset to default, persisted per user (localStorage)
// Availability rules (permissions, disabled modules, SaaS entitlements,
// overrides, roles) are resolved ONCE per render from the same sources the
// sidebar uses.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  GripVertical, X, Plus, Check, RotateCcw, Pencil, ArrowRight, MousePointerClick,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useHrm } from "../store"
import { hiddenModulesOf } from "../module-map"
import { cn } from "@/lib/utils"
import {
  effectiveRowSpan, effectiveSpan, type PlacedWidget, type WidgetCtx, type WidgetDef,
  type WidgetGates, type WidgetRowSpan, type WidgetSize,
} from "./types"
import {
  availableWidgets, buildDefaultLayout, clearSavedLayout, loadSavedLayout, persistLayout, WIDGET_BY_ID,
} from "./registry"

const GRID_GAP = 12
/** One grid row unit for vertical sizing (widgets spanning N rows get N
 *  units + the gaps between them). Feed widgets are designed against this. */
const ROW_UNIT_PX = 148

/** Responsive column mode: 12 exact (xl+), 6 half-row (md/lg), 1 stacked (mobile). */
function useGridCols(): 12 | 6 | 1 {
  const [cols, setCols] = useState<12 | 6 | 1>(12)
  useEffect(() => {
    const xl = window.matchMedia("(min-width: 1280px)")
    const md = window.matchMedia("(min-width: 768px)")
    const update = () => setCols(xl.matches ? 12 : md.matches ? 6 : 1)
    update()
    xl.addEventListener("change", update)
    md.addEventListener("change", update)
    return () => {
      xl.removeEventListener("change", update)
      md.removeEventListener("change", update)
    }
  }, [])
  return cols
}

export function CustomizableDashboard({ data }: { data: any }) {
  const user = useHrm((s) => s.user)
  const navigate = useHrm((s) => s.navigate)
  const can = useHrm((s) => s.can)
  const settings = useHrm((s) => s.settings)
  const subscription = useHrm((s) => s.subscription)

  // ---- availability gates (same sources as the sidebar nav) ----
  const gates: WidgetGates = useMemo(() => ({
    can,
    hiddenModules: hiddenModulesOf(settings),
    subscription: subscription
      ? { mode: subscription.mode, features: subscription.features, overrides: subscription.overrides ?? null }
      : null,
    role: user?.role || "",
  }), [can, settings, subscription, user?.role])

  const available = useMemo(() => availableWidgets(gates), [gates])
  const availableIds = useMemo(() => new Set(available.map((d) => d.id)), [available])

  // ---- resolved layout: saved (gated) or default ----
  // savedVersion forces a re-read of localStorage after save/reset so the
  // resolved layout immediately reflects what was just persisted
  const [savedVersion, setSavedVersion] = useState(0)
  const savedLayout = useMemo(
    () => loadSavedLayout(user?.id || "", available),
    [user?.id, available, savedVersion],
  )
  const defaultLayout = useMemo(() => buildDefaultLayout(available), [available])
  const resolvedLayout: PlacedWidget[] = savedLayout?.widgets ?? defaultLayout

  // ---- edit mode state ----
  const [editing, setEditing] = useState(false)
  const [working, setWorking] = useState<PlacedWidget[] | null>(null)
  const layout = working ?? resolvedLayout

  // ---- drag & drop state ----
  const dragIdRef = useRef<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null)

  // ---- resize state (horizontal: columns · vertical: rows) ----
  const gridRef = useRef<HTMLDivElement>(null)
  const [resize, setResize] = useState<
    | { id: string; axis: "x"; startX: number; startSize: number; colUnit: number }
    | { id: string; axis: "y"; startY: number; startRows: number }
    | null
  >(null)
  const [liveSize, setLiveSize] = useState<number | null>(null)
  const [liveRows, setLiveRows] = useState<number | null>(null)

  // ---- widget picker ----
  const [pickerOpen, setPickerOpen] = useState(false)

  const cols = useGridCols()
  const ctx: WidgetCtx = useMemo(() => ({ data, navigate, can }), [data, navigate, can])

  // ---- mutations (operate on the working copy; create it on demand) ----
  const ensureWorking = (): PlacedWidget[] => {
    if (working) return working
    const copy = [...resolvedLayout]
    setWorking(copy)
    return copy
  }

  const moveWidget = (srcId: string, targetId: string, side: "before" | "after") => {
    const base = ensureWorking()
    const arr = [...base]
    const from = arr.findIndex((w) => w.id === srcId)
    if (from < 0) return
    const [item] = arr.splice(from, 1)
    let to = arr.findIndex((w) => w.id === targetId)
    if (to < 0) { arr.push(item); setWorking(arr); return }
    if (side === "after") to += 1
    arr.splice(to, 0, item)
    setWorking(arr)
  }

  const setSize = (id: string, size: WidgetSize) => {
    const base = ensureWorking()
    setWorking(base.map((w) => (w.id === id ? { ...w, size } : w)))
  }
  const setRowSpan = (id: string, rowSpan: WidgetRowSpan) => {
    const base = ensureWorking()
    setWorking(base.map((w) => (w.id === id ? { ...w, rowSpan } : w)))
  }
  const removeWidget = (id: string) => {
    const base = ensureWorking()
    setWorking(base.filter((w) => w.id !== id))
  }

  const addWidget = (id: string) => {
    const def = WIDGET_BY_ID[id]
    if (!def || !availableIds.has(id)) return
    const base = ensureWorking()
    if (base.some((w) => w.id === id)) return
    setWorking([...base, { id, size: def.defaultSize, ...(def.defaultRowSpan && def.defaultRowSpan > 1 ? { rowSpan: def.defaultRowSpan } : {}) }])
  }

  // ---- edit-mode lifecycle ----
  const enterEdit = () => { setEditing(true); setWorking([...resolvedLayout]) }
  const saveEdit = () => {
    if (working) persistLayout(user?.id || "", { widgets: working })
    setSavedVersion((v) => v + 1)
    setEditing(false)
    setWorking(null)
  }
  const cancelEdit = () => { setEditing(false); setWorking(null) }
  const resetToDefault = () => {
    clearSavedLayout(user?.id || "")
    setSavedVersion((v) => v + 1)
    setWorking(buildDefaultLayout(available))
  }

  // ---- drag handlers (HTML5 DnD) ----
  const onDragStart = (e: React.DragEvent, id: string) => {
    dragIdRef.current = id
    setDragId(id)
    e.dataTransfer.effectAllowed = "move"
    e.dataTransfer.setData("text/plain", id)
  }
  const onDragOverWidget = (e: React.DragEvent, id: string) => {
    if (!dragIdRef.current || dragIdRef.current === id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const side = e.clientX < rect.left + rect.width / 2 ? "before" : "after"
    setDropTarget((prev) => (prev?.id === id && prev.side === side ? prev : { id, side }))
  }
  const onDropWidget = (e: React.DragEvent, id: string) => {
    e.preventDefault()
    const src = dragIdRef.current
    if (src && src !== id) moveWidget(src, id, dropTarget?.id === id ? dropTarget.side : "after")
    endDrag()
  }
  const onDropGrid = (e: React.DragEvent) => {
    e.preventDefault()
    const src = dragIdRef.current
    if (src) {
      // dropped on grid background → move to the end
      const base = ensureWorking()
      const arr = [...base]
      const from = arr.findIndex((w) => w.id === src)
      if (from >= 0) {
        const [item] = arr.splice(from, 1)
        arr.push(item)
        setWorking(arr)
      }
    }
    endDrag()
  }
  const endDrag = () => {
    dragIdRef.current = null
    setDragId(null)
    setDropTarget(null)
  }

  // ---- resize handlers (pointer capture; x = columns, y = rows) ----
  const startColResize = (e: React.PointerEvent, w: PlacedWidget) => {
    e.preventDefault()
    e.stopPropagation()
    const grid = gridRef.current
    if (!grid) return
    const rect = grid.getBoundingClientRect()
    const colUnit = (rect.width - 11 * GRID_GAP) / 12 + GRID_GAP
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setResize({ id: w.id, axis: "x", startX: e.clientX, startSize: w.size, colUnit })
    setLiveSize(w.size)
  }
  const startRowResize = (e: React.PointerEvent, w: PlacedWidget) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setResize({ id: w.id, axis: "y", startY: e.clientY, startRows: w.rowSpan ?? 1 })
    setLiveRows(w.rowSpan ?? 1)
  }
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resize) return
    const def = WIDGET_BY_ID[resize.id]
    if (resize.axis === "x") {
      const min = def?.minSize ?? 3
      const delta = Math.round((e.clientX - resize.startX) / resize.colUnit)
      const next = Math.max(min, Math.min(12, resize.startSize + delta)) as WidgetSize
      setLiveSize(next)
      setSize(resize.id, next)
    } else {
      const minRows = def?.minRowSpan ?? 1
      const rowUnitWithGap = ROW_UNIT_PX + GRID_GAP
      const delta = Math.round((e.clientY - resize.startY) / rowUnitWithGap)
      const next = Math.max(minRows, Math.min(3, resize.startRows + delta)) as WidgetRowSpan
      setLiveRows(next)
      setRowSpan(resize.id, next)
    }
  }
  const endResize = (e: React.PointerEvent) => {
    if (resize) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* already released */ }
    }
    setResize(null)
    setLiveSize(null)
    setLiveRows(null)
  }

  const placedIds = new Set(layout.map((w) => w.id))
  const pickerDefs = available.filter((d) => !placedIds.has(d.id))

  // ---- skeleton while stats are loading ----
  if (!data) return <DashboardSkeleton />

  return (
    <div>
      {/* ---- customize toolbar ---- */}
      {editing ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/[0.04] dark:bg-primary/[0.06] px-3 py-2.5 mb-3">
          <div className="flex items-center gap-2 text-xs font-medium text-primary min-w-0">
            <MousePointerClick className="h-4 w-4 shrink-0" />
            <span className="truncate">Customizing — drag to reorder, corner handle to resize columns, bottom handle to span rows</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Add widget
              {pickerDefs.length > 0 && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[9px]">{pickerDefs.length}</Badge>}
            </Button>
            <Button variant="ghost" size="sm" onClick={resetToDefault} title="Restore the recommended layout">
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
            <Button size="sm" onClick={saveEdit}>
              <Check className="h-3.5 w-3.5" /> Save layout
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end mb-2.5 -mt-1">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={enterEdit}>
            <Pencil className="h-3.5 w-3.5" /> Customize
          </Button>
        </div>
      )}

      {/* ---- the grid ---- */}
      <div
        ref={gridRef}
        className="hrm-dash-grid"
        style={{ gridAutoRows: `minmax(${ROW_UNIT_PX}px, auto)` }}
        onDragOver={(e) => { if (dragIdRef.current) e.preventDefault() }}
        onDrop={onDropGrid}
      >
        {layout.map((w) => {
          const def = WIDGET_BY_ID[w.id]
          if (!def) return null
          const span = effectiveSpan(w.size, cols)
          const rowSpan = effectiveRowSpan(w.rowSpan, cols)
          const Icon = def.icon
          const isDragging = dragId === w.id
          const dropSide: "before" | "after" | null = dropTarget?.id === w.id ? dropTarget.side : null
          const dropBefore = dropSide === "before" && !isDragging
          const dropAfter = dropSide === "after" && !isDragging
          return (
            <section
              key={w.id}
              aria-label={def.title}
              draggable={editing}
              onDragStart={editing ? (e) => onDragStart(e, w.id) : undefined}
              onDragEnd={endDrag}
              onDragOver={editing ? (e) => onDragOverWidget(e, w.id) : undefined}
              onDrop={editing ? (e) => onDropWidget(e, w.id) : undefined}
              style={{
                gridColumn: `span ${span} / span ${span}`,
                ...(rowSpan > 1 ? { gridRow: `span ${rowSpan} / span ${rowSpan}` } : {}),
              }}
              className={cn(
                "hrm-widget hrm-widget-in relative flex flex-col overflow-hidden",
                editing && "hrm-widget-editing",
                isDragging && "hrm-widget-dragging",
                dropBefore && !isDragging && "hrm-widget-drop-before",
                dropAfter && !isDragging && "hrm-widget-drop-after",
              )}
            >
              {/* widget header */}
              <div className={cn("flex items-center gap-2 h-9 px-3 shrink-0", editing ? "border-b cursor-grab active:cursor-grabbing bg-muted/40" : "border-b")}>
                {editing && <GripVertical className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" aria-hidden />}
                <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 tracking-tight truncate">{def.title}</h3>
                <div className="ml-auto flex items-center gap-1 shrink-0">
                  {editing ? (
                    <span className="text-[10px] tabular-nums text-muted-foreground mr-0.5">
                      {w.size}/12{rowSpan > 1 ? ` · ${rowSpan}r` : ""}
                    </span>
                  ) : def.linkTo ? (
                    <button onClick={() => { const target = def.linkTo; if (target) navigate(target) }}
                      className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline hrm-focus rounded">
                      View <ArrowRight className="h-3 w-3" />
                    </button>
                  ) : null}
                  {editing && (
                    <button onClick={() => removeWidget(w.id)} aria-label={`Remove ${def.title}`}
                      className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-rose-600 hover:bg-rose-500/10 transition-colors hrm-focus">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {/* widget body */}
              <div className={cn("p-3 flex-1 min-h-0 overflow-hidden", def.bodyClassName)}>{def.render(ctx)}</div>
              {/* resize handles (edit mode) */}
              {editing && (
                <>
                  <div
                    role="separator"
                    aria-label={`Resize ${def.title} columns`}
                    aria-orientation="vertical"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft") setSize(w.id, Math.max(def.minSize ?? 3, w.size - 1) as WidgetSize)
                      if (e.key === "ArrowRight") setSize(w.id, Math.min(12, w.size + 1) as WidgetSize)
                    }}
                    onPointerDown={(e) => startColResize(e, w)}
                    onPointerMove={onResizeMove}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    className="hrm-widget-resize flex items-end justify-end"
                    title="Drag to resize columns"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="mb-0.5 mr-0.5">
                      <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                  {/* vertical handle — span multiple grid rows (2026-10 expansion) */}
                  <div
                    role="separator"
                    aria-label={`Resize ${def.title} rows`}
                    aria-orientation="horizontal"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp") setRowSpan(w.id, Math.max(def.minRowSpan ?? 1, (w.rowSpan ?? 1) - 1) as WidgetRowSpan)
                      if (e.key === "ArrowDown") setRowSpan(w.id, Math.min(3, (w.rowSpan ?? 1) + 1) as WidgetRowSpan)
                    }}
                    onPointerDown={(e) => startRowResize(e, w)}
                    onPointerMove={onResizeMove}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    className="hrm-widget-resize-y flex items-end justify-center"
                    title="Drag to span more rows"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="mb-0.5">
                      <path d="M5 1 L5 9 M2 6 L5 9 L8 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </>
              )}
            </section>
          )
        })}
      </div>

      {/* empty state: user removed everything */}
      {layout.length === 0 && (
        <div className="hrm-widget flex flex-col items-center justify-center py-14 text-center">
          <p className="text-sm font-medium text-muted-foreground">Your dashboard is empty</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Add widgets to build your ideal workspace.</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => setPickerOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add widget
          </Button>
        </div>
      )}

      {/* live size chips while resizing */}
      {resize?.axis === "x" && liveSize != null && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-full bg-foreground text-background text-xs font-semibold px-3 py-1 tabular-nums shadow-lg" aria-hidden>
          {liveSize} / 12 columns
        </div>
      )}
      {resize?.axis === "y" && liveRows != null && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-full bg-foreground text-background text-xs font-semibold px-3 py-1 tabular-nums shadow-lg" aria-hidden>
          {liveRows} row{liveRows > 1 ? "s" : ""} spanned
        </div>
      )}

      {/* ---- widget picker ---- */}
      <WidgetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        defs={pickerDefs}
        placedCount={layout.length}
        onAdd={(id) => { addWidget(id) }}
      />
    </div>
  )
}

// ============ widget picker dialog ============
const CATEGORY_ORDER = [
  "Overview", "People", "Time & Attendance", "Payroll & Finance", "Compliance & Alerts",
  "Communication", "Operations", "Platform",
] as const

function WidgetPicker({ open, onOpenChange, defs, placedCount, onAdd }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  defs: WidgetDef[]
  placedCount: number
  onAdd: (id: string) => void
}) {
  const byCategory = CATEGORY_ORDER
    .map((cat) => ({ cat, items: defs.filter((d) => d.category === cat) }))
    .filter((g) => g.items.length > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] overflow-y-auto scroll-thin">
        <DialogHeader>
          <DialogTitle className="text-base">Widget library</DialogTitle>
          <DialogDescription className="text-xs">
            {defs.length > 0
              ? "Add widgets to your dashboard — they follow your permissions, enabled modules and plan."
              : `All available widgets are already on your dashboard (${placedCount} placed).`}
          </DialogDescription>
        </DialogHeader>
        {byCategory.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground">Nothing left to add.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {byCategory.map(({ cat, items }) => (
              <div key={cat}>
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1.5">{cat}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {items.map((d) => {
                    const Icon = d.icon
                    return (
                      <div key={d.id} className="flex gap-2.5 rounded-lg border bg-card p-2.5 hover:border-primary/40 transition-colors">
                        <div className="h-8 w-8 shrink-0 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold truncate">{d.title}</p>
                          <p className="text-[11px] text-muted-foreground line-clamp-2 leading-snug">{d.description}</p>
                        </div>
                        <Button size="sm" variant="outline" className="h-7 self-center shrink-0" onClick={() => onAdd(d.id)}>
                          <Plus className="h-3.5 w-3.5" /> Add
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ============ loading skeleton shaped like the default layout ============
function DashboardSkeleton() {
  const rows: number[][] = [
    [12],
    [12],
    [8, 4],
    [4, 4, 4],
    [4, 4, 4],
    [4, 4, 4],
  ]
  return (
    <div>
      <div className="flex justify-end mb-2.5 -mt-1">
        <div className="h-7 w-24 rounded-md bg-muted/60 animate-pulse" />
      </div>
      <div className="hrm-dash-grid">
        {rows.flat().map((span, i) => (
          <div key={i} style={{ gridColumn: `span ${span} / span ${span}` }} className="hrm-widget h-[120px] flex items-center justify-center">
            <div className="h-8 w-8 rounded-lg bg-muted/70 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}

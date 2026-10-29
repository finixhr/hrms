"use client"
// ============ Stock Inventory — items, warehouses, stock levels, entries ============
// Stock moves ONLY through stock entries (POST) and manual adjustments — every
// movement writes a StockTransaction row (previousQty/newQty captured) so the
// ledger is complete and auditable (spec §16).
// WP-L: an inventory item can be issued to an employee as a tracked company
// asset. Since 2026-10-16 issuing goes through an ASSET_ISSUE approval — the
// request reserves nothing, and stock deducts only at final approval.
import { useEffect, useState } from "react"
import {
  Boxes, Plus, Trash2, RefreshCcw, ClipboardCheck, Warehouse, Package, Landmark,
  AlertTriangle, Loader2, PackagePlus, History, Eye, PackageSearch, Check, ChevronsUpDown, Search, Lock,
  Tags, Scale, Barcode, MoreHorizontal, ArrowLeftRight, SlidersHorizontal,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useHrm } from "../store"
import { rpc, useApi, useEmployeeDirectory } from "../api"

// HRM store toast (text, kind) — same signature every other view uses
const toast = (text: string, kind?: "ok" | "err") => useHrm.getState().toast(text, kind)
import {
  PageHeader, StatCard, SectionCard, SectionTabs, StatusBadge, fmtMoney, fmtDate, fmtDateTime, titleCase,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

export default function InventoryView() {
  const { can: _can } = useHrm()
  const tabs = [
    { value: "overview", label: "Stock Overview", content: <OverviewTab /> },
    { value: "items", label: "Items", content: <ItemsTab /> },
    { value: "warehouses", label: "Warehouses", content: <WarehousesTab /> },
    { value: "categories", label: "Categories", content: <CategoriesTab /> },
    { value: "units", label: "Units", content: <UnitsTab /> },
    { value: "entries", label: "Stock Entries", content: <EntriesTab /> },
    { value: "transactions", label: "Transactions", content: <TransactionsTab /> },
  ]
  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock Inventory"
        subtitle="Items on hand, warehouses, goods receipts and the complete movement ledger — every change is transactional and audited"
      />
      {/* M-23 — search deep links pre-select the tab */}
      <SectionTabs defaultValue={(useHrm((st) => (st.view?.key === "inventory" && (st.view?.params as any)?.tab)) as string) || "overview"} tabs={tabs} />
    </div>
  )
}

// ================= OVERVIEW =================
function OverviewTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any>("inventory.stock.overview", {})
  const [adjust, setAdjust] = useState<any>(null)
  // WP-L — issue an item straight to an employee as a tracked asset
  const [issueItem, setIssueItem] = useState<any>(null)
  const [transferItem, setTransferItem] = useState<any>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [detailItem, setDetailItem] = useState<any>(null)
  const canIssueAsset = can("inventory", "edit") && can("assets", "assign")

  const columns: Column<any>[] = [
    { key: "name", label: "Item", sortValue: (i) => i.name, render: (i) => (
      <div className="flex items-center gap-2">
        <Package className={`h-4 w-4 shrink-0 ${i.low ? "text-amber-500" : "text-slate-400"}`} />
        <div>
          <p className="text-sm font-semibold">{i.name}{i.code ? <span className="text-slate-400 font-normal"> ({i.code})</span> : ""}</p>
          <p className="text-[11px] text-slate-500">{i.category} · {i.isReturnable ? "Returnable asset" : "Consumable"}</p>
        </div>
      </div>
    ) },
    { key: "warehouses", label: "Warehouse Stock", render: (i) => (
      <div className="flex flex-wrap gap-1 max-w-xs">
        {i.byWarehouse && i.byWarehouse.length > 0 ? (
          i.byWarehouse.map((w: any) => (
            <Badge key={w.warehouseId} variant="outline" className="text-[10px] font-normal border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50">
              <span className="font-semibold text-slate-700 dark:text-slate-200 mr-1">{w.warehouseName}:</span>
              <span className="tabular-nums font-medium">{w.quantity}</span>
              {w.reserved > 0 && <span className="text-sky-600 ml-1">({w.reserved} res)</span>}
            </Badge>
          ))
        ) : (
          <span className="text-[11px] text-slate-400">0 in all warehouses</span>
        )}
      </div>
    ) },
    { key: "onHand", label: "On hand", align: "right", sortValue: (i) => i.onHand, render: (i) => (
      <span className="text-sm font-semibold tabular-nums">{i.onHand} <span className="text-[10px] text-slate-400">{i.unit}</span></span>
    ) },
    { key: "reserved", label: "Reserved", align: "right", sortValue: (i) => i.reserved, render: (i) => i.reserved > 0 ? <span className="text-xs tabular-nums text-sky-600">{i.reserved}</span> : <span className="text-slate-400 text-xs">—</span> },
    { key: "available", label: "Available", align: "right", sortValue: (i) => i.available, render: (i) => (
      <div>
        <span className={`text-sm font-bold tabular-nums ${i.available <= 0 ? "text-rose-600" : i.low ? "text-amber-600" : "text-emerald-700 dark:text-emerald-400"}`}>{i.available}</span>
        {/* asset-issue requests awaiting approval block their qty without moving the ledger */}
        {!!i.pendingIssue && <p className="text-[10px] text-sky-600 dark:text-sky-400" title="Qty in asset-issue requests awaiting approval — unavailable for further issues">−{i.pendingIssue} pending approval</p>}
      </div>
    ) },
    { key: "reorderLevel", label: "Reorder at", align: "right", sortValue: (i) => i.reorderLevel, render: (i) => <span className="text-xs text-slate-500 tabular-nums">{i.reorderLevel || "—"}</span> },
    { key: "value", label: "Value", align: "right", sortValue: (i) => i.onHand * (i.lastCost || i.unitCost || 0), render: (i) => <span className="text-xs tabular-nums">{fmtMoney(i.onHand * (i.lastCost || i.unitCost || 0))}</span> },
    { key: "actions", label: "", align: "right", render: (i) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200" onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 text-xs">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setDetailItem(i); }}>
            <Eye className="h-3.5 w-3.5 mr-2 text-slate-500" /> View Details
          </DropdownMenuItem>
          {canIssueAsset && (
            <DropdownMenuItem
              disabled={(i.issueable ?? i.onHand) < 1 || !i.isReturnable}
              onClick={(e) => { e.stopPropagation(); setIssueItem(i); }}
            >
              <PackageSearch className="h-3.5 w-3.5 mr-2 text-indigo-500" /> Issue as Asset
            </DropdownMenuItem>
          )}
          {can("inventory", "edit") && (
            <DropdownMenuItem
              disabled={i.onHand < 1}
              onClick={(e) => { e.stopPropagation(); setTransferItem(i); setTransferOpen(true); }}
            >
              <ArrowLeftRight className="h-3.5 w-3.5 mr-2 text-sky-500" /> Transfer to Warehouse
            </DropdownMenuItem>
          )}
          {can("inventory", "edit") && (
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setAdjust(i); }}>
              <SlidersHorizontal className="h-3.5 w-3.5 mr-2 text-amber-500" /> Adjust
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Items tracked" value={data?.summary?.itemCount ?? "—"} icon={Boxes} tone="emerald" />
        <StatCard label="Units on hand" value={data?.summary?.totalOnHand ?? "—"} icon={Package} tone="teal" />
        <StatCard label="Stock value" value={fmtMoney(data?.summary?.totalValue || 0)} icon={Landmark} tone="sky" />
        <StatCard label="Low stock items" value={data?.summary?.lowStock ?? "—"} sub="at/below reorder level" icon={AlertTriangle} tone="amber" />
        <StatCard label="Recent movements" value={`${data?.summary?.entryCount ?? 0} in · ${data?.summary?.issueCount ?? 0} out`} icon={History} tone="slate" />
      </div>
      <SectionCard title="Items on hand" actions={
        <div className="flex items-center gap-1.5">
          {can("inventory", "edit") && (
            <Button size="sm" className="h-8 text-xs" onClick={() => { setTransferItem(null); setTransferOpen(true); }}>
              <ArrowLeftRight className="h-3.5 w-3.5 mr-1" /> Transfer Stock
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={reload}>
            <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </div>
      }>
        <DataTable
          columns={columns}
          rows={data?.items?.filter((i: any) => i.active)}
          loading={loading}
          error={error}
          pageSize={12}
          csvName="stock-overview"
          onRowClick={(item) => setDetailItem(item)}
          searchPlaceholder="Search item…"
          emptyTitle="No items yet"
          emptyHint="Create items under the Items tab, then receive stock via a stock entry."
        />
      </SectionCard>
      {detailItem && (
        <StockItemDetailDialog
          item={detailItem}
          warehouses={data?.warehouses || []}
          onClose={() => setDetailItem(null)}
          onAdjust={() => { const it = detailItem; setDetailItem(null); setAdjust(it); }}
          onTransfer={() => { const it = detailItem; setDetailItem(null); setTransferItem(it); setTransferOpen(true); }}
          onIssue={() => { const it = detailItem; setDetailItem(null); setIssueItem(it); }}
        />
      )}
      {transferOpen && (
        <TransferStockDialog
          initialItem={transferItem}
          items={data?.items?.filter((i: any) => i.active) || []}
          warehouses={data?.warehouses || []}
          onClose={(v) => { setTransferOpen(false); setTransferItem(null); if (v) reload(); }}
        />
      )}
      {adjust && <AdjustDialog item={adjust} warehouses={data?.warehouses || []} onClose={(v) => { setAdjust(null); if (v) reload() }} />}
      {issueItem && <IssueAsAssetDialog item={issueItem} onClose={(v) => { setIssueItem(null); if (v) reload() }} />}
    </div>
  )
}

function StockItemDetailDialog({
  item,
  warehouses,
  onClose,
  onAdjust,
  onTransfer,
  onIssue,
}: {
  item: any
  warehouses: any[]
  onClose: () => void
  onAdjust?: () => void
  onTransfer?: () => void
  onIssue?: () => void
}) {
  const { data: serialsData } = useApi<any[]>(
    item?.id ? "inventory.items.availableSerials" : null,
    { itemId: item.id }
  )
  const serials = Array.isArray(serialsData) ? serialsData : (serialsData as any)?.serials || []

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle className="text-base flex items-center gap-2">
              <Package className="h-5 w-5 text-emerald-600" />
              <span>{item.name}</span>
              {item.code && <span className="font-mono text-xs text-slate-400 font-normal">({item.code})</span>}
            </DialogTitle>
            <Badge variant="secondary" className="text-xs">
              {item.isReturnable ? "Returnable Asset" : "Consumable"}
            </Badge>
          </div>
          <DialogDescription className="text-xs">
            Complete inventory status, warehouse locations, and stock breakdown for {item.name}.
          </DialogDescription>
        </DialogHeader>

        {/* Key Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 py-1">
          <div className="p-2.5 rounded-lg border bg-slate-50/70 dark:bg-slate-900/40">
            <p className="text-[10px] uppercase font-semibold text-slate-500">Total On Hand</p>
            <p className="text-base font-bold text-slate-900 dark:text-slate-100">{item.onHand} <span className="text-xs font-normal text-slate-400">{item.unit}</span></p>
          </div>
          <div className="p-2.5 rounded-lg border bg-slate-50/70 dark:bg-slate-900/40">
            <p className="text-[10px] uppercase font-semibold text-slate-500">Available</p>
            <p className={`text-base font-bold ${item.available <= 0 ? "text-rose-600" : "text-emerald-600"}`}>{item.available} <span className="text-xs font-normal text-slate-400">{item.unit}</span></p>
          </div>
          <div className="p-2.5 rounded-lg border bg-slate-50/70 dark:bg-slate-900/40">
            <p className="text-[10px] uppercase font-semibold text-slate-500">Reserved</p>
            <p className="text-base font-bold text-sky-600">{item.reserved || 0} <span className="text-xs font-normal text-slate-400">{item.unit}</span></p>
          </div>
          <div className="p-2.5 rounded-lg border bg-slate-50/70 dark:bg-slate-900/40">
            <p className="text-[10px] uppercase font-semibold text-slate-500">Unit Cost</p>
            <p className="text-base font-bold text-slate-900 dark:text-slate-100">{fmtMoney(item.lastCost || item.unitCost || 0)}</p>
          </div>
        </div>

        {/* Warehouse Breakdown */}
        <div className="space-y-1.5 pt-2">
          <Label className="text-xs font-bold uppercase tracking-wider text-slate-500">Warehouse Wise Stock Status</Label>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-800 text-[11px]">
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="text-right">On Hand</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {warehouses.map((wh: any) => {
                  const match = (item.byWarehouse || []).find((w: any) => w.warehouseId === wh.id)
                  const onHand = match ? match.quantity : 0
                  const reserved = match ? match.reserved : 0
                  const available = match ? match.available : 0
                  return (
                    <TableRow key={wh.id} className="text-xs">
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-1.5">
                          <Warehouse className="h-3.5 w-3.5 text-slate-400" />
                          <span>{wh.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{onHand} {item.unit}</TableCell>
                      <TableCell className="text-right tabular-nums text-sky-600">{reserved > 0 ? reserved : "—"}</TableCell>
                      <TableCell className={`text-right tabular-nums font-semibold ${available > 0 ? "text-emerald-600" : "text-slate-400"}`}>
                        {available} {item.unit}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Tracked Serials if available */}
        {serials.length > 0 && (
          <div className="space-y-1.5 pt-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-bold uppercase tracking-wider text-slate-500">Serials / IMEIs in Stock</Label>
              <span className="text-[10px] text-slate-400 font-mono">{serials.length} available</span>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-2 rounded-lg border bg-slate-50/50 dark:bg-slate-900/30">
              {serials.map((s: any) => (
                <Badge key={s.id} variant="outline" className="font-mono text-[11px] bg-white dark:bg-slate-800">
                  {s.serialNumber}
                  {s.brandModel && <span className="text-slate-400 ml-1">({s.brandModel})</span>}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 pt-3 flex flex-wrap justify-between sm:justify-between items-center">
          <div className="flex flex-wrap gap-2">
            {onIssue && item.isReturnable && item.issueable > 0 && (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onIssue}>
                <PackageSearch className="h-3.5 w-3.5 mr-1 text-indigo-600" /> Issue as Asset
              </Button>
            )}
            {onTransfer && item.onHand > 0 && (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onTransfer}>
                <ArrowLeftRight className="h-3.5 w-3.5 mr-1 text-sky-600" /> Transfer
              </Button>
            )}
            {onAdjust && (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onAdjust}>
                <SlidersHorizontal className="h-3.5 w-3.5 mr-1 text-amber-600" /> Adjust
              </Button>
            )}
          </div>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TransferStockDialog({
  initialItem,
  items,
  warehouses,
  onClose,
}: {
  initialItem?: any
  items: any[]
  warehouses: any[]
  onClose: (saved: boolean) => void
}) {
  const [selectedItemId, setSelectedItemId] = useState(initialItem?.id || (items[0]?.id || ""))
  const [fromWhId, setFromWhId] = useState("")
  const [toWhId, setToWhId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [remarks, setRemarks] = useState("")
  const [selectedSerials, setSelectedSerials] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const chosenItem = items.find((x) => x.id === selectedItemId) || initialItem
  const activeWarehouses = (warehouses || []).filter((w) => w.active !== false)

  // Find warehouses with stock for this item
  const warehousesWithStock = activeWarehouses.map((wh) => {
    const match = (chosenItem?.byWarehouse || []).find((w: any) => w.warehouseId === wh.id)
    const onHand = match ? match.quantity : 0
    const reserved = match ? match.reserved : 0
    const available = Math.max(0, onHand - reserved)
    return { ...wh, onHand, reserved, available }
  })

  // Auto-select source warehouse with available stock
  useEffect(() => {
    if (!fromWhId) {
      const best = warehousesWithStock.find((w) => w.available > 0)
      if (best) setFromWhId(best.id)
    }
  }, [selectedItemId, warehousesWithStock, fromWhId])

  // Destination warehouses (must be different from source)
  const destWarehouses = activeWarehouses.filter((w) => w.id !== fromWhId)

  // Fetch available serials in source warehouse
  const { data: serialsData } = useApi<any[]>(
    chosenItem?.id && fromWhId ? "inventory.items.availableSerials" : null,
    { itemId: chosenItem?.id, warehouseId: fromWhId }
  )
  const availableSerials = Array.isArray(serialsData) ? serialsData : (serialsData as any)?.serials || []

  const sourceWh = warehousesWithStock.find((w) => w.id === fromWhId)
  const maxAvailable = sourceWh?.available || 0

  const handleTransfer = async () => {
    setErr(null)
    const qtyNum = Number(quantity)
    if (!chosenItem) { setErr("Select an item to transfer"); return }
    if (!fromWhId) { setErr("Select source warehouse"); return }
    if (!toWhId) { setErr("Select destination warehouse"); return }
    if (fromWhId === toWhId) { setErr("Source and destination warehouses must be different"); return }
    if (!qtyNum || qtyNum <= 0) { setErr("Quantity must be greater than 0"); return }
    if (qtyNum > maxAvailable) { setErr(`Cannot transfer more than available quantity (${maxAvailable} ${chosenItem.unit || "Pcs"})`); return }

    setBusy(true)
    try {
      const res = await rpc("inventory.stock.transfer", {
        itemId: chosenItem.id,
        fromWarehouseId: fromWhId,
        toWarehouseId: toWhId,
        quantity: qtyNum,
        remarks: remarks.trim() || undefined,
        serialNumbers: selectedSerials.length > 0 ? selectedSerials : undefined,
      })
      toast(`Transferred ${qtyNum} ${chosenItem.unit || "Pcs"} of ${chosenItem.name} (${res.transferRef})`)
      onClose(true)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-sky-600" />
            <span>Transfer Stock Between Warehouses</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            Move inventory items and their serials between warehouses with full ledger audit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-1">
          {/* Item Selector */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Item to Transfer *</Label>
            {initialItem ? (
              <div className="h-9 px-3 flex items-center justify-between rounded-md border bg-slate-50 dark:bg-slate-900 text-xs font-semibold">
                <span>{initialItem.name} {initialItem.code ? `(${initialItem.code})` : ""}</span>
                <span className="text-slate-500 font-normal">{initialItem.onHand} {initialItem.unit} total</span>
              </div>
            ) : (
              <Select value={selectedItemId} onValueChange={(val) => { setSelectedItemId(val); setFromWhId(""); setSelectedSerials([]); }}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select item…" /></SelectTrigger>
                <SelectContent className="max-h-56">
                  {items.map((it: any) => (
                    <SelectItem key={it.id} value={it.id}>
                      {it.name} ({it.onHand} {it.unit} on hand)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Source and Destination Warehouses */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">From Warehouse *</Label>
              <Select value={fromWhId} onValueChange={(val) => { setFromWhId(val); setSelectedSerials([]); }}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select source…" /></SelectTrigger>
                <SelectContent>
                  {warehousesWithStock.map((w) => (
                    <SelectItem key={w.id} value={w.id} disabled={w.available <= 0}>
                      {w.name} ({w.available} avail)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {sourceWh && (
                <p className="text-[10px] text-slate-500">
                  Available to move: <span className="font-semibold text-emerald-600">{maxAvailable} {chosenItem?.unit}</span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">To Warehouse *</Label>
              <Select value={toWhId} onValueChange={setToWhId}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select destination…" /></SelectTrigger>
                <SelectContent>
                  {destWarehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Quantity */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Transfer Quantity *</Label>
              {sourceWh && (
                <span className="text-[10px] text-slate-400">Max: {maxAvailable} {chosenItem?.unit}</span>
              )}
            </div>
            <Input
              type="number"
              min={1}
              max={maxAvailable || undefined}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="h-9 text-xs tabular-nums"
              placeholder="Quantity to transfer"
            />
          </div>

          {/* Optional Serial Numbers selection */}
          {availableSerials.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">
                  Select Specific Serials / IMEIs to Transfer ({selectedSerials.length} / {Number(quantity) || 0} selected)
                </Label>
                {selectedSerials.length > 0 && (
                  <button type="button" onClick={() => setSelectedSerials([])} className="text-[10px] text-sky-600 hover:underline">
                    Clear
                  </button>
                )}
              </div>
              <div className="rounded-lg border p-2 max-h-32 overflow-y-auto space-y-1 bg-slate-50/50 dark:bg-slate-900/40">
                {availableSerials.map((s: any) => {
                  const isChecked = selectedSerials.includes(s.serialNumber)
                  const isDisabled = !isChecked && selectedSerials.length >= Number(quantity)
                  return (
                    <label
                      key={s.id}
                      className={`flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer border ${
                        isChecked ? "border-sky-300 bg-sky-50 dark:bg-sky-950/40" : isDisabled ? "opacity-50 cursor-not-allowed border-transparent" : "hover:bg-white dark:hover:bg-slate-800 border-transparent"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isDisabled}
                        onChange={(e) => {
                          if (e.target.checked) {
                            if (selectedSerials.length < Number(quantity)) {
                              setSelectedSerials([...selectedSerials, s.serialNumber])
                            }
                          } else {
                            setSelectedSerials(selectedSerials.filter((x) => x !== s.serialNumber))
                          }
                        }}
                      />
                      <span className="font-mono">{s.serialNumber}</span>
                      {s.brandModel && <span className="text-[10px] text-slate-400">· {s.brandModel}</span>}
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {/* Remarks */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Transfer Reason / Remarks</Label>
            <Input
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              className="h-9 text-xs"
              placeholder="e.g. Branch replenishment, rebalancing stock"
            />
          </div>

          {err && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950 p-2.5 rounded-md">{err}</p>}
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={handleTransfer} disabled={busy || maxAvailable <= 0}>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5 mr-1.5" />}
            Confirm Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AdjustDialog({ item, warehouses, onClose }: { item: any; warehouses: any[]; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [v, setV] = useState({ warehouseId: "", delta: "", remarks: "" })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setErr(null)
    const delta = Number(v.delta)
    if (!Number.isFinite(delta) || delta === 0) { setErr("Enter a non-zero adjustment (+/−)"); return }
    if (!v.remarks || v.remarks.trim().length < 3) { setErr("An adjustment reason is required (audit trail)"); return }
    setBusy(true)
    try {
      await rpc("inventory.stock.adjust", { itemId: item.id, warehouseId: v.warehouseId || null, delta, remarks: v.remarks })
      toast(`${item.name} adjusted by ${delta > 0 ? "+" : ""}${delta} — transaction recorded`)
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Adjust stock — {item.name}</DialogTitle>
          <DialogDescription className="text-xs">Manual correction with a mandatory reason. Every adjustment writes an ADJUST transaction with the before/after quantities.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Warehouse</Label>
            <Select value={v.warehouseId || "main"} onValueChange={(val) => setV((s) => ({ ...s, warehouseId: val === "main" ? "" : val }))}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="main">Main / default</SelectItem>
                {(warehouses || []).map((w: any) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Adjustment (+/− {item.unit})</Label>
            <Input type="number" value={v.delta} onChange={(e) => setV((s) => ({ ...s, delta: e.target.value }))} className="h-9 tabular-nums" placeholder="e.g. 2 or -1" />
            <p className="text-[10px] text-slate-500">Current on hand: {item.onHand} {item.unit} · adjustment cannot make stock negative</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Reason *</Label>
            <Input value={v.remarks} onChange={(e) => setV((s) => ({ ...s, remarks: e.target.value }))} className="h-9" placeholder="e.g. damaged unit written off" />
          </div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Apply adjustment"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= ITEMS =================
function ItemsTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("inventory.items.list", {})
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<any>(null)
  // WP-L — issue an item straight to an employee as a tracked asset
  const [issueItem, setIssueItem] = useState<any>(null)
  const canIssueAsset = can("inventory", "edit") && can("assets", "assign")

  const columns: Column<any>[] = [
    { key: "name", label: "Item", sortValue: (i) => i.name, render: (i) => (
      <div>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{i.name}</p>
        <p className="text-[11px] text-slate-500">
          {i.code || "no code"} · {i.category}
        </p>
      </div>
    ) },
    { key: "unit", label: "Unit", render: (i) => <span className="text-xs">{i.unit}</span> },
    {
      key: "isReturnable", label: "Returnable Asset",
      render: (i) => i.isReturnable ? (
        <Badge className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 text-[10px]">
          Yes (Asset Tracked)
        </Badge>
      ) : (
        <span className="text-xs text-slate-400">No (Consumable)</span>
      ),
    },
    { key: "onHand", label: "On hand", align: "right", sortValue: (i) => i.onHand, render: (i) => <span className="text-xs font-semibold tabular-nums">{i.onHand}</span> },
    { key: "unitCost", label: "Unit cost", align: "right", sortValue: (i) => i.unitCost, render: (i) => <span className="text-xs tabular-nums">{fmtMoney(i.unitCost ?? i.lastCost)}</span> },
    { key: "reorderLevel", label: "Reorder at", align: "right", render: (i) => <span className="text-xs tabular-nums">{i.reorderLevel || "—"}</span> },
    { key: "status", label: "Status", render: (i) => <StatusBadge status={i.active ? "ACTIVE" : "INACTIVE"} /> },
    ...(can("inventory", "edit") || canIssueAsset ? [{ key: "actions", label: "", align: "right" as const, render: (i: any) => (
      <div className="flex gap-1 justify-end">
        {canIssueAsset && (
          <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" disabled={(i.issueable ?? i.onHand) < 1}
            title={!i.isReturnable ? "Consumable item (non-returnable)" : (i.issueable ?? i.onHand) < 1 ? "Nothing issueable — stock is reserved or pending approval" : "Request units issued to an employee as tracked company assets (approval required)"}
            onClick={() => setIssueItem(i)}>
            <PackageSearch className="h-3 w-3 mr-1" /> Issue as asset
          </Button>
        )}
        {can("inventory", "edit") && (
          <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => { setEdit(i); setOpen(true) }}>Edit</Button>
        )}
      </div>
    ) }] : []),
  ]

  return (
    <div className="space-y-3">
      {can("inventory", "edit") && (
        <div className="flex justify-end">
          <Button size="sm" className="h-8 text-xs " onClick={() => { setEdit(null); setOpen(true) }}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add item
          </Button>
        </div>
      )}
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} pageSize={12} csvName="inventory-items"
        searchPlaceholder="Search item…" emptyTitle="No items" emptyHint="Create the office goods you track — laptops, chairs, stationery…" />
      {open && <ItemDialog edit={edit} onClose={(v) => { setOpen(false); if (v) reload() }} />}
      {issueItem && <IssueAsAssetDialog item={issueItem} onClose={(v) => { setIssueItem(null); if (v) reload() }} />}
    </div>
  )
}

// ================= WP-L — ISSUE ITEM AS A TRACKED ASSET (approval flow) =================
// 2026-10-16 — issuing no longer moves stock immediately. The dialog collects
// a SEARCHABLE employee picker + an Issue Qty validated against issueable
// stock (on hand − reserved − qty pending approval) and submits an ASSET_ISSUE
// approval request; the stock OUT + tracked assets happen ONLY after the
// workflow fully approves (server: applyAssetIssueDecision).
function IssueAsAssetDialog({ item, onClose }: { item: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const { data: employees } = useEmployeeDirectory()
  const { data: availableSerials } = useApi<any[]>("inventory.items.availableSerials", { itemId: item.id })
  const serialList: any[] = availableSerials || []
  const [selectedSerials, setSelectedSerials] = useState<string[]>([])
  // ACTIVE/PROBATION only — same assignability rule the server enforces
  const empOpts = ((employees || []) as any[])
    .filter((e) => ["ACTIVE", "PROBATION"].includes(e.status))
    .map((e) => ({ id: e.id as string, name: e.fullName as string, code: (e.code || "") as string }))
  const [empOpen, setEmpOpen] = useState(false)
  const [v, setV] = useState({ employeeId: "", qty: "1", conditionOut: "NEW", note: "" })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const selected = empOpts.find((e) => e.id === v.employeeId)

  // available for issue = on hand − reserved − qty already pending approval
  const onHand = Number(item.onHand) || 0
  const reserved = Number(item.reserved) || 0
  const pending = Number(item.pendingIssue) || 0
  const issueable = Math.max(0, onHand - reserved - pending)
  const qtyNum = Math.floor(Number(v.qty) || 0)
  const qtyError = !v.qty || qtyNum < 1
    ? "Issue Qty must be at least 1"
    : qtyNum > issueable
      ? `Issue Qty cannot exceed ${issueable} — the rest is reserved or pending approval`
      : null

  useEffect(() => {
    if (selectedSerials.length > qtyNum) {
      setSelectedSerials((prev) => prev.slice(0, Math.max(0, qtyNum)))
    }
  }, [qtyNum, selectedSerials.length])

  const submit = async () => {
    if (!v.employeeId) { setErr("Select the employee to issue to"); return }
    if (qtyError) { setErr(qtyError); return }
    setBusy(true); setErr(null)
    try {
      await rpc<{ approvalId: string; status: string }>("inventory.issueAsAsset", {
        itemId: item.id, employeeId: v.employeeId, qty: qtyNum,
        conditionOut: v.conditionOut || null, note: v.note || null,
        selectedSerials: selectedSerials.length > 0 ? selectedSerials : undefined,
      })
      toast(`Asset issue request sent — ${qtyNum} × ${item.name} awaits approval; stock deducts after final approval`)
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(false) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Issue “{item.name}” as asset</DialogTitle>
          <DialogDescription className="text-xs">
            The request goes to the Approval Queue — stock goes OUT of the primary warehouse ONLY after final approval.
            Each unit becomes a tracked asset (auto AST-code) assigned to the employee.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {(item.brandModel || item.hasWarranty) && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-2.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-600 dark:text-slate-300">
              {item.brandModel && <span>Brand/Model: <strong className="text-slate-800 dark:text-slate-100">{item.brandModel}</strong></span>}
              {item.hasWarranty && <span className="text-emerald-700 dark:text-emerald-400 font-medium">Warranty: Yes</span>}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
            {/* searchable employee picker (Popover + Command, reports.tsx pattern) */}
            <div className="space-y-1.5 sm:col-span-3">
              <Label className="text-xs font-medium">Issue to <span className="text-rose-500">*</span></Label>
              <Popover open={empOpen} onOpenChange={setEmpOpen}>
                <PopoverTrigger asChild>
                  <button type="button" role="combobox" aria-expanded={empOpen} aria-controls="issue-to-emp-list"
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-xs text-left flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <span className={`truncate flex-1 ${selected ? "text-slate-700 dark:text-slate-200" : "text-slate-400"}`}>
                      {selected ? `${selected.name}${selected.code ? ` (${selected.code})` : ""}` : "Select…"}
                    </span>
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search employee…" className="h-8 text-xs" />
                    <CommandList id="issue-to-emp-list" className="max-h-56">
                      <CommandEmpty className="text-xs py-3">No employee found.</CommandEmpty>
                      <CommandGroup>
                        {empOpts.map((e) => (
                          <CommandItem key={e.id} value={`${e.name} ${e.code}`}
                            onSelect={() => { setV((s) => ({ ...s, employeeId: e.id })); setEmpOpen(false) }} className="text-xs">
                            <Check className={`h-3.5 w-3.5 mr-1.5 ${v.employeeId === e.id ? "opacity-100" : "opacity-0"}`} />
                            <span className="truncate">{e.name}</span>
                            {e.code && <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">{e.code}</span>}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-[10px] text-slate-500">Only ACTIVE or PROBATION employees are assignable.</p>
            </div>
            {/* Issue Qty — validated against issueable stock (server re-validates) */}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="issue-qty" className="text-xs font-medium">Issue Qty <span className="text-rose-500">*</span></Label>
              <Input id="issue-qty" type="number" min={1} max={issueable} step={1} value={v.qty}
                onChange={(e) => setV((s) => ({ ...s, qty: e.target.value }))}
                aria-invalid={!!qtyError}
                className={`h-9 tabular-nums ${qtyError && v.qty ? "border-rose-400 focus-visible:ring-rose-300" : ""}`} />
              <p className={`text-[10px] ${qtyError && v.qty ? "text-rose-600" : "text-slate-500"}`}>
                {qtyError && v.qty ? qtyError : (
                  <>Available: <span className="font-semibold tabular-nums">{issueable}</span> of {onHand} on hand{pending > 0 ? ` · ${pending} pending approval` : ""}</>
                )}
              </p>
            </div>
          </div>

          {/* Serial / IMEI selection from stock */}
          {serialList.length > 0 ? (
            qtyNum === 1 ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">Select Serial / IMEI (from stock)</Label>
                  <span className="text-[10px] text-slate-500 font-mono">{serialList.length} available</span>
                </div>
                <Select
                  value={selectedSerials[0] || "auto"}
                  onValueChange={(val) => setSelectedSerials(val === "auto" ? [] : [val])}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Auto-assign or select serial…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-assign (next available serial)</SelectItem>
                    {serialList.map((s: any) => (
                      <SelectItem key={s.id} value={s.serialNumber}>
                        {s.serialNumber} {s.warrantyExpiry ? `· Exp: ${fmtDate(s.warrantyExpiry)}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">
                    Select Serials / IMEIs ({selectedSerials.length} / {qtyNum} selected)
                  </Label>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 font-mono">{serialList.length} in stock</span>
                    {selectedSerials.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedSerials([])}
                        className="text-[10px] text-sky-600 hover:underline"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2 max-h-36 overflow-y-auto space-y-1 bg-slate-50/60 dark:bg-slate-900/40">
                  {serialList.map((s: any) => {
                    const isChecked = selectedSerials.includes(s.serialNumber)
                    const isDisabled = !isChecked && selectedSerials.length >= qtyNum
                    return (
                      <label
                        key={s.id}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer border transition-colors ${
                          isChecked
                            ? "border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/50 text-sky-950 dark:text-sky-100"
                            : isDisabled
                            ? "border-transparent opacity-50 cursor-not-allowed"
                            : "border-transparent hover:bg-white dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={isDisabled}
                          onChange={(e) => {
                            if (e.target.checked) {
                              if (selectedSerials.length < qtyNum) {
                                setSelectedSerials([...selectedSerials, s.serialNumber])
                              }
                            } else {
                              setSelectedSerials(selectedSerials.filter((x) => x !== s.serialNumber))
                            }
                          }}
                          className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                        />
                        <span className="font-mono font-medium">{s.serialNumber}</span>
                        {s.warrantyExpiry && (
                          <span className="text-[10px] text-slate-500 ml-auto">Warranty: {fmtDate(s.warrantyExpiry)}</span>
                        )}
                      </label>
                    )
                  })}
                </div>
                <p className="text-[10px] text-slate-500">
                  {selectedSerials.length < qtyNum
                    ? `Selected ${selectedSerials.length} of ${qtyNum}. Any unselected units will auto-assign remaining available serials from stock.`
                    : `All ${qtyNum} unit serials selected.`}
                </p>
              </div>
            )
          ) : (
            (item.brandModel || item.hasWarranty || item.isReturnable) && (
              <p className="text-[10px] text-slate-400 italic">
                No individual serial numbers tracked in stock for this item. Asset(s) will be created using item details.
              </p>
            )
          )}

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Condition at handover</Label>
            <Select value={v.conditionOut} onValueChange={(val) => setV((s) => ({ ...s, conditionOut: val }))}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{["NEW", "GOOD", "FAIR", "DAMAGED"].map((c) => <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Handover note</Label>
            <Textarea value={v.note} onChange={(e) => setV((s) => ({ ...s, note: e.target.value }))} rows={2} placeholder="e.g. charger + bag included" />
          </div>
          <p className="text-[11px] rounded-md bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 px-2.5 py-1.5">
            Requesting <span className="font-semibold tabular-nums">{qtyNum > 0 ? qtyNum : "—"}</span> of {issueable} issueable · stock and asset records are created only when the request is fully approved.
          </p>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !v.employeeId || !!qtyError || issueable < 1}>Send for approval</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ItemDialog({ edit, onClose }: { edit: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const { data: codeData } = useApi<{ nextCode: string }>(!edit ? "inventory.items.nextCode" : null)
  const { data: categories } = useApi<any[]>("inventory.categories.list", {})
  const { data: units } = useApi<any[]>("inventory.units.list", {})

  const activeCategories = (categories || []).filter((c) => c.active !== false)
  const activeUnits = (units || []).filter((u) => u.active !== false)

  const [v, setV] = useState({
    code: edit?.code || "",
    name: edit?.name || "",
    category: edit?.category || "OTHER",
    unit: edit?.unit || "Pcs",
    unitCost: edit?.unitCost ?? edit?.lastCost ?? "",
    reorderLevel: edit?.reorderLevel ?? "",
    isReturnable: !!edit?.isReturnable,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (n: string, val: any) => setV((s) => ({ ...s, [n]: val }))

  useEffect(() => {
    if (!edit && codeData?.nextCode && !v.code) {
      set("code", codeData.nextCode)
    }
  }, [codeData, edit])

  // When adding, default category to first active category if not already set
  useEffect(() => {
    if (!edit && activeCategories.length > 0 && (!v.category || v.category === "OTHER")) {
      const match = activeCategories.find((c) => c.name === v.category)
      if (!match) set("category", activeCategories[0].name)
    }
  }, [activeCategories, edit])

  // When adding, default unit to first active unit if not set
  useEffect(() => {
    if (!edit && activeUnits.length > 0 && (!v.unit || v.unit === "Pcs")) {
      const match = activeUnits.find((u) => (u.symbol || u.name) === v.unit)
      if (!match) set("unit", activeUnits[0].symbol || activeUnits[0].name)
    }
  }, [activeUnits, edit])

  const save = async () => {
    if (!v.name) { setErr("Item name is required"); return }
    setBusy(true); setErr(null)
    try {
      await rpc("inventory.items.save", {
        ...(edit?.id ? { id: edit.id } : {}),
        ...v,
        unitCost: Number(v.unitCost || 0),
        lastCost: Number(v.unitCost || 0),
        reorderLevel: Number(v.reorderLevel || 0),
        active: edit?.active ?? true,
      })
      toast(edit ? "Item updated" : "Item created")
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle className="text-base">{edit ? `Edit — ${edit.name}` : "Add item"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-1">
          <div className="space-y-1.5"><Label className="text-xs font-medium">Name *</Label><Input value={v.name} onChange={(e) => set("name", e.target.value)} className="h-9" placeholder="e.g. Laptop" /></div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Item Code</Label>
              <span className="text-[10px] text-slate-400 dark:text-slate-500 flex items-center gap-1 font-medium">
                <Lock className="h-2.5 w-2.5" /> Auto-locked
              </span>
            </div>
            <Input
              value={v.code || (edit?.code ?? codeData?.nextCode ?? "Generating…")}
              disabled
              readOnly
              className="h-9 font-mono text-xs cursor-not-allowed bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 select-none"
              placeholder="ITM-0001"
              title="Item code is sequentially auto-generated by the system and locked for entry"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Category</Label>
            <Select value={v.category} onValueChange={(val) => set("category", val)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select category…" /></SelectTrigger>
              <SelectContent>
                {activeCategories.map((c) => (
                  <SelectItem key={c.id || c.name} value={c.name}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Unit</Label>
            <Select value={v.unit} onValueChange={(val) => set("unit", val)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select unit…" /></SelectTrigger>
              <SelectContent>
                {activeUnits.map((u) => (
                  <SelectItem key={u.id || u.symbol || u.name} value={u.symbol || u.name}>
                    {u.name} {u.symbol && u.symbol !== u.name ? `(${u.symbol})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5"><Label className="text-xs font-medium">Unit cost (৳)</Label><Input type="number" value={v.unitCost} onChange={(e) => set("unitCost", e.target.value)} className="h-9 tabular-nums" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Reorder level</Label><Input type="number" value={v.reorderLevel} onChange={(e) => set("reorderLevel", e.target.value)} className="h-9 tabular-nums" /></div>

          <div className="col-span-2 space-y-1.5 pt-1 border-t border-slate-100 dark:border-slate-800">
            <Label className="text-xs font-medium">Is it returnable to company during holder's leave from company?</Label>
            <div className="flex items-center justify-between h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
              <span className="text-xs text-slate-600 dark:text-slate-300">
                {v.isReturnable
                  ? "Yes — Used for company asset tracking & issued as asset to employees"
                  : "No — Consumable / Non-returnable item"}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <Switch checked={v.isReturnable} onCheckedChange={(c) => set("isReturnable", c)} id="isReturnable" />
                <Label htmlFor="isReturnable" className="text-xs cursor-pointer select-none font-semibold min-w-8">
                  {v.isReturnable ? "Yes" : "No"}
                </Label>
              </div>
            </div>
          </div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save item"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= WAREHOUSES =================
function WarehousesTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("inventory.warehouses.list", {})
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<any>(null)

  const columns: Column<any>[] = [
    { key: "name", label: "Warehouse", sortValue: (w) => w.name, render: (w) => (
      <div className="flex items-center gap-2"><Warehouse className="h-4 w-4 text-slate-400" /><div><p className="text-sm font-semibold">{w.name}</p>{w.code && <p className="text-[11px] text-slate-500">{w.code}</p>}</div></div>
    ) },
    { key: "address", label: "Address", render: (w) => <span className="text-xs">{w.address || "—"}</span> },
    { key: "status", label: "Status", render: (w) => <StatusBadge status={w.active ? "ACTIVE" : "INACTIVE"} /> },
    ...(can("inventory", "edit") ? [{ key: "actions", label: "", align: "right" as const, render: (w: any) => (
      <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => { setEdit(w); setOpen(true) }}>Edit</Button>
    ) }] : []),
  ]

  return (
    <div className="space-y-3">
      {can("inventory", "edit") && (
        <div className="flex justify-end">
          <Button size="sm" className="h-8 text-xs " onClick={() => { setEdit(null); setOpen(true) }}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add warehouse
          </Button>
        </div>
      )}
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} pageSize={10} csvName="warehouses"
        searchPlaceholder="Search warehouse…" emptyTitle="No warehouses" emptyHint="A default warehouse is used when none is assigned." />
      {open && <WarehouseDialog edit={edit} onClose={(v) => { setOpen(false); if (v) reload() }} />}
    </div>
  )
}

function WarehouseDialog({ edit, onClose }: { edit: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [v, setV] = useState({ name: edit?.name || "", code: edit?.code || "", address: edit?.address || "" })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    if (!v.name) { setErr("Name is required"); return }
    setBusy(true); setErr(null)
    try {
      await rpc("inventory.warehouses.save", { ...(edit?.id ? { id: edit.id } : {}), ...v })
      toast(edit ? "Warehouse updated" : "Warehouse created")
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle className="text-base">{edit ? `Edit — ${edit.name}` : "Add warehouse"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label className="text-xs font-medium">Name *</Label><Input value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} className="h-9" placeholder="e.g. Head Office Store" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Code</Label><Input value={v.code} onChange={(e) => setV((s) => ({ ...s, code: e.target.value }))} className="h-9" placeholder="e.g. WH-01" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Address</Label><Input value={v.address} onChange={(e) => setV((s) => ({ ...s, address: e.target.value }))} className="h-9" /></div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= CATEGORIES =================
function CategoriesTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("inventory.categories.list", {})
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<any>(null)

  const columns: Column<any>[] = [
    {
      key: "name", label: "Category", sortValue: (c) => c.name,
      render: (c) => (
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 flex items-center justify-center shrink-0">
            <Tags className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{c.name}</p>
            {c.description && <p className="text-[11px] text-slate-500">{c.description}</p>}
          </div>
        </div>
      ),
    },
    {
      key: "itemCount", label: "Items Using", align: "center", sortValue: (c) => c.itemCount ?? 0,
      render: (c) => (
        <Badge variant="secondary" className="font-mono text-xs">
          {c.itemCount ?? 0} item{c.itemCount === 1 ? "" : "s"}
        </Badge>
      ),
    },
    { key: "status", label: "Status", render: (c) => <StatusBadge status={c.active ? "ACTIVE" : "INACTIVE"} /> },
    ...(can("inventory", "edit") ? [{
      key: "actions", label: "", align: "right" as const,
      render: (c: any) => (
        <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => { setEdit(c); setOpen(true) }}>
          Edit
        </Button>
      ),
    }] : []),
  ]

  return (
    <div className="space-y-3">
      {can("inventory", "edit") && (
        <div className="flex justify-end">
          <Button size="sm" className="h-8 text-xs" onClick={() => { setEdit(null); setOpen(true) }}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add category
          </Button>
        </div>
      )}
      <DataTable
        columns={columns}
        rows={data ?? undefined}
        loading={loading}
        error={error}
        pageSize={12}
        csvName="inventory-categories"
        searchPlaceholder="Search category…"
        emptyTitle="No categories"
        emptyHint="Create categories to organize your inventory items (e.g. IT, Furniture, Stationery…)"
      />
      {open && <CategoryDialog edit={edit} onClose={(v) => { setOpen(false); if (v) reload() }} />}
    </div>
  )
}

function CategoryDialog({ edit, onClose }: { edit: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [name, setName] = useState(edit?.name || "")
  const [description, setDescription] = useState(edit?.description || "")
  const [active, setActive] = useState(edit?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim()) { setErr("Category name is required"); return }
    setBusy(true); setErr(null)
    try {
      await rpc("inventory.categories.save", {
        ...(edit?.id ? { id: edit.id } : {}),
        name: name.trim(),
        description: description.trim() || null,
        active,
      })
      toast(edit ? "Category updated" : "Category created")
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{edit ? `Edit — ${edit.name}` : "Add category"}</DialogTitle>
          <DialogDescription className="text-xs">
            Categories group items in the catalogue, stock overview, and procurement requisition workflows.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Category name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IT, FURNITURE, MEDICAL" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Computer hardware, monitors and peripherals" className="h-9" />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
            <div>
              <Label htmlFor="cat-active" className="text-xs font-medium cursor-pointer">Active</Label>
              <p className="text-[11px] text-slate-500">Active categories appear in item selection dropdowns.</p>
            </div>
            <Switch id="cat-active" checked={active} onCheckedChange={setActive} />
          </div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save category"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= UNITS =================
function UnitsTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("inventory.units.list", {})
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<any>(null)

  const columns: Column<any>[] = [
    {
      key: "name", label: "Unit of Measurement", sortValue: (u) => u.name,
      render: (u) => (
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md bg-sky-50 dark:bg-sky-950/60 border border-sky-200 dark:border-sky-800/60 flex items-center justify-center shrink-0">
            <Scale className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{u.name}</p>
          </div>
        </div>
      ),
    },
    {
      key: "symbol", label: "Symbol / Short Code",
      render: (u) => u.symbol ? (
        <Badge variant="outline" className="font-mono text-xs">
          {u.symbol}
        </Badge>
      ) : (
        <span className="text-xs text-slate-400">—</span>
      ),
    },
    {
      key: "itemCount", label: "Items Using", align: "center", sortValue: (u) => u.itemCount ?? 0,
      render: (u) => (
        <Badge variant="secondary" className="font-mono text-xs">
          {u.itemCount ?? 0} item{u.itemCount === 1 ? "" : "s"}
        </Badge>
      ),
    },
    { key: "status", label: "Status", render: (u) => <StatusBadge status={u.active ? "ACTIVE" : "INACTIVE"} /> },
    ...(can("inventory", "edit") ? [{
      key: "actions", label: "", align: "right" as const,
      render: (u: any) => (
        <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => { setEdit(u); setOpen(true) }}>
          Edit
        </Button>
      ),
    }] : []),
  ]

  return (
    <div className="space-y-3">
      {can("inventory", "edit") && (
        <div className="flex justify-end">
          <Button size="sm" className="h-8 text-xs" onClick={() => { setEdit(null); setOpen(true) }}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add unit
          </Button>
        </div>
      )}
      <DataTable
        columns={columns}
        rows={data ?? undefined}
        loading={loading}
        error={error}
        pageSize={12}
        csvName="inventory-units"
        searchPlaceholder="Search unit…"
        emptyTitle="No units"
        emptyHint="Define units of measurement (e.g. Pieces, Box, Packet, Kg, Meter, Ream…)"
      />
      {open && <UnitDialog edit={edit} onClose={(v) => { setOpen(false); if (v) reload() }} />}
    </div>
  )
}

function UnitDialog({ edit, onClose }: { edit: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [name, setName] = useState(edit?.name || "")
  const [symbol, setSymbol] = useState(edit?.symbol || "")
  const [active, setActive] = useState(edit?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim()) { setErr("Unit name is required"); return }
    setBusy(true); setErr(null)
    try {
      await rpc("inventory.units.save", {
        ...(edit?.id ? { id: edit.id } : {}),
        name: name.trim(),
        symbol: symbol.trim() || null,
        active,
      })
      toast(edit ? "Unit updated" : "Unit created")
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{edit ? `Edit — ${edit.name}` : "Add unit"}</DialogTitle>
          <DialogDescription className="text-xs">
            Units define how stock quantities and pack sizes are counted (e.g. Pieces, Box, Packet, Kg, Ream).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Unit name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pieces, Box, Kilogram, Packet" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Symbol / Short code</Label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="e.g. Pcs, Box, Kg, Pkt" className="h-9" />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
            <div>
              <Label htmlFor="unit-active" className="text-xs font-medium cursor-pointer">Active</Label>
              <p className="text-[11px] text-slate-500">Active units appear in item and stock requisition dropdowns.</p>
            </div>
            <Switch id="unit-active" checked={active} onCheckedChange={setActive} />
          </div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save unit"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= STOCK ENTRIES =================
function EntriesTab() {
  const { can } = useHrm()
  const [status, setStatus] = useState("")
  const { data, loading, error, reload } = useApi<any[]>("inventory.stock.entries.list", status ? { status } : {})
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<any>(null)

  const post = async (e: any) => {
    setBusy(e.id)
    try {
      await rpc("inventory.stock.entries.post", { id: e.id })
      toast(`Stock entry ${e.entryNo} posted — quantities are now on hand`)
      reload()
    } catch (err: any) { toast(err.message, "err") } finally { setBusy(null) }
  }

  const columns: Column<any>[] = [
    { key: "entryNo", label: "Entry", sortValue: (e) => e.entryNo, render: (e) => (
      <div><p className="text-sm font-semibold">{e.entryNo}</p><p className="text-[11px] text-slate-500">{fmtDate(e.receivedDate)}{e.purchaseReqNo ? ` · from ${e.purchaseReqNo}` : ""}</p></div>
    ) },
    { key: "supplierName", label: "Supplier", render: (e) => <span className="text-xs">{e.supplierName || "—"}</span> },
    { key: "invoiceNo", label: "Invoice", render: (e) => <span className="text-xs">{e.invoiceNo || "—"}</span> },
    { key: "warehouseName", label: "Warehouse", render: (e) => <span className="text-xs">{e.warehouseName}</span> },
    { key: "itemCount", label: "Lines", align: "right", render: (e) => <span className="text-xs">{e.itemCount}</span> },
    { key: "totalCost", label: "Total cost", align: "right", sortValue: (e) => e.totalCost, render: (e) => <span className="text-xs font-semibold tabular-nums">{fmtMoney(e.totalCost)}</span> },
    { key: "status", label: "Status", render: (e) => <StatusBadge status={e.status} /> },
    { key: "actions", label: "", align: "right", render: (e) => (
      <div className="flex gap-1 justify-end">
        <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setView(e)}>
          <Eye className="h-3 w-3 mr-1" /> View
        </Button>
        {e.status === "DRAFT" && can("inventory", "approve") && (
          <Button size="sm" className="h-7 text-[11px] bg-teal-600 hover:bg-teal-700 text-white" disabled={busy === e.id} onClick={() => post(e)}>
            {busy === e.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ClipboardCheck className="h-3 w-3 mr-1" />} Post
          </Button>
        )}
      </div>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All entries</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem>
            <SelectItem value="POSTED">Posted</SelectItem>
          </SelectContent>
        </Select>
        {can("inventory", "create") && (
          <Button size="sm" className="h-8 text-xs " onClick={() => setOpen(true)}>
            <PackagePlus className="h-3.5 w-3.5 mr-1" /> New stock entry
          </Button>
        )}
      </div>
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} pageSize={12} csvName="stock-entries"
        searchPlaceholder="Search entry no, supplier…" emptyTitle="No stock entries" emptyHint="Stock entries record goods received — quantities rise when the entry is posted." />
      {open && <StockEntryDialog onClose={(v) => { setOpen(false); if (v) reload() }} />}
      {view && <StockEntryDetailDialog entry={view} onClose={() => setView(null)} />}
    </div>
  )
}

/** Fix #8 — per-row View: every line of the entry, its status trail and costs. */
function StockEntryDetailDialog({ entry, onClose }: { entry: any; onClose: () => void }) {
  const lines: any[] = entry.items || []
  const total = lines.reduce((s: number, l: any) => s + l.quantity * l.unitCost, 0)
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2 flex-wrap">
            Stock entry {entry.entryNo || entry.code} <StatusBadge status={entry.status} />
          </DialogTitle>
          <DialogDescription className="text-xs">
            {fmtDate(entry.receivedDate || entry.entryDate)} · {entry.warehouseName || "—"}{entry.supplierName ? ` · ${entry.supplierName}` : ""}{entry.purchaseReqNo ? ` · purchase ${entry.purchaseReqNo}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1.5">
            <p className="text-[10px] uppercase text-slate-500">Invoice</p>
            <p className="font-medium">{entry.invoiceNo || "—"}</p>
          </div>
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1.5">
            <p className="text-[10px] uppercase text-slate-500">Lines</p>
            <p className="font-medium tabular-nums">{lines.length}</p>
          </div>
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1.5">
            <p className="text-[10px] uppercase text-slate-500">Total cost</p>
            <p className="font-medium tabular-nums">{fmtMoney(total)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1.5">
            <p className="text-[10px] uppercase text-slate-500">{entry.status === "POSTED" ? "Posted by" : "Created by"}</p>
            <p className="font-medium">{entry.postedByName || entry.byUserName || "—"}</p>
          </div>
        </div>
        <div className="rounded-xl border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50 dark:bg-slate-800">
                <TableHead className="text-[10px] uppercase">Item</TableHead>
                <TableHead className="text-[10px] uppercase">Brand & Model</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Qty</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Unit cost</TableHead>
                <TableHead className="text-[10px] uppercase">Warranty</TableHead>
                <TableHead className="text-[10px] uppercase">Serial / IMEI</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => {
                let serials: string[] = []
                if (l.serialNumbers) {
                  try {
                    const parsed = JSON.parse(l.serialNumbers)
                    if (Array.isArray(parsed)) serials = parsed
                    else serials = [String(l.serialNumbers)]
                  } catch {
                    serials = String(l.serialNumbers).split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean)
                  }
                }
                return (
                  <TableRow key={l.id}>
                    <TableCell className="py-2">
                      <p className="text-xs font-medium">{l.itemName}</p>
                      {l.remarks && <p className="text-[10px] text-slate-500">{l.remarks}</p>}
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 dark:text-slate-300">
                      {l.brandModel || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{l.quantity}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{fmtMoney(l.unitCost)}</TableCell>
                    <TableCell className="text-xs">
                      {l.warrantyValue ? (
                        <span className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                          {l.warrantyValue} {titleCase(l.warrantyUnit || "MONTHS")}
                          {l.warrantyExpiry && (
                            <span className="text-[10px] text-slate-400 font-normal">({fmtDate(l.warrantyExpiry)})</span>
                          )}
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {serials.length > 0 ? (
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {serials.map((s: string, idx: number) => (
                            <Badge key={idx} variant="outline" className="font-mono text-[10px] px-1.5 py-0">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums font-semibold">{fmtMoney(l.quantity * l.unitCost)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        {entry.remarks && <p className="text-xs text-slate-500">{entry.remarks}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ManageSerialsDialog({
  itemName,
  quantity,
  initialSerials,
  onSave,
  onClose,
}: {
  itemName: string
  quantity: number
  initialSerials: string[]
  onSave: (serials: string[]) => void
  onClose: () => void
}) {
  const [serials, setSerials] = useState<string[]>(() => {
    const arr = [...(initialSerials || [])]
    while (arr.length < quantity) arr.push("")
    return arr.slice(0, quantity)
  })
  const [bulkText, setBulkText] = useState("")
  const [activeTab, setActiveTab] = useState<"list" | "bulk">("list")

  const applyBulk = () => {
    const parsed = bulkText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
    const next = [...serials]
    for (let i = 0; i < quantity; i++) {
      if (parsed[i] !== undefined) next[i] = parsed[i]
    }
    setSerials(next)
    setActiveTab("list")
  }

  const handleSave = () => {
    onSave(serials.map((s) => s.trim()).filter(Boolean))
    onClose()
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Barcode className="h-4 w-4 text-slate-500" />
            Enter Serials / IMEIs ({quantity} units)
          </DialogTitle>
          <DialogDescription className="text-xs">
            {itemName || "Item"} · Provide individual serial or IMEI number for each received unit.
          </DialogDescription>
        </DialogHeader>

        <div className="flex border-b border-slate-200 dark:border-slate-800 text-xs">
          <button
            type="button"
            className={`px-3 py-2 font-medium border-b-2 -mb-px transition-colors ${
              activeTab === "list"
                ? "border-sky-600 text-sky-600 dark:border-sky-400 dark:text-sky-400"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
            onClick={() => setActiveTab("list")}
          >
            Unit-by-unit ({serials.filter(Boolean).length}/{quantity})
          </button>
          <button
            type="button"
            className={`px-3 py-2 font-medium border-b-2 -mb-px transition-colors ${
              activeTab === "bulk"
                ? "border-sky-600 text-sky-600 dark:border-sky-400 dark:text-sky-400"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
            onClick={() => setActiveTab("bulk")}
          >
            Bulk paste
          </button>
        </div>

        {activeTab === "list" ? (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1 py-1">
            {Array.from({ length: quantity }).map((_, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-slate-400 w-16 shrink-0">Unit #{idx + 1}</span>
                <Input
                  value={serials[idx] || ""}
                  onChange={(e) => {
                    const next = [...serials]
                    next[idx] = e.target.value
                    setSerials(next)
                  }}
                  placeholder={`Serial / IMEI for unit ${idx + 1}`}
                  className="h-8 text-xs font-mono"
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2 py-1">
            <Label className="text-xs font-medium">Paste serial numbers (one per line or comma separated):</Label>
            <Textarea
              rows={6}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={"SN-001\nSN-002\nSN-003"}
              className="font-mono text-xs"
            />
            <Button type="button" size="sm" variant="secondary" className="h-7 text-xs w-full" onClick={applyBulk}>
              Apply pasted serials
            </Button>
          </div>
        )}

        <DialogFooter className="gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-rose-500 hover:text-rose-600"
            onClick={() => setSerials(Array(quantity).fill(""))}
          >
            Clear all
          </Button>
          <div className="flex-1" />
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSave}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StockEntryDialog({ onClose }: { onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const { data: items } = useApi<any[]>("inventory.items.list", {})
  const { data: warehouses } = useApi<any[]>("inventory.warehouses.list", {})
  const { data: suppliers } = useApi<any[]>("inventory.suppliers.list", {})
  const { data: prs } = useApi<any[]>("purchase.list", { status: "PENDING_STOCK_ENTRY" })
  const [v, setV] = useState({ purchaseRequestId: "", supplierId: "", warehouseId: "", invoiceNo: "", invoiceDate: "", receivedDate: new Date().toISOString().slice(0, 10), remarks: "" })
  const [lines, setLines] = useState<any[]>([{ itemId: "", brandModel: "", quantity: 1, unitCost: "", warrantyValue: "", warrantyUnit: "MONTHS", serials: [] }])
  const [serialModalIndex, setSerialModalIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (n: string, val: any) => setV((s) => ({ ...s, [n]: val }))

  // selecting a PR prefills its lines
  const onPrChange = async (id: string) => {
    set("purchaseRequestId", id)
    if (!id) return
    try {
      const pr = await rpc("purchase.get", { id })
      setLines((pr.items || []).map((i: any) => ({
        itemId: i.itemId,
        brandModel: "",
        quantity: i.purchaseQty,
        unitCost: i.unitPrice || "",
        warrantyValue: "",
        warrantyUnit: "MONTHS",
        serials: [],
      })))
      if (pr.supplierId) set("supplierId", pr.supplierId)
    } catch { /* keep manual lines */ }
  }

  const save = async () => {
    setErr(null)
    const clean = lines.filter((l) => l.itemId && Number(l.quantity) > 0)
    if (!clean.length) { setErr("Add at least one item line with a positive quantity"); return }
    setBusy(true)
    try {
      const rec = await rpc("inventory.stock.entries.save", {
        ...v, purchaseRequestId: v.purchaseRequestId || null, supplierId: v.supplierId || null, warehouseId: v.warehouseId || null,
        items: clean.map((l) => ({
          itemId: l.itemId,
          brandModel: l.brandModel ? l.brandModel.trim() : null,
          quantity: Number(l.quantity),
          unitCost: Number(l.unitCost || 0),
          warrantyValue: l.warrantyValue !== "" && l.warrantyValue != null ? Number(l.warrantyValue) : null,
          warrantyUnit: l.warrantyUnit || "MONTHS",
          serials: l.serials || [],
        })),
      })
      toast(`Stock entry ${rec.entryNo} created as DRAFT — post it to increase stock`)
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">New stock entry (goods receipt)</DialogTitle>
          <DialogDescription className="text-xs">Created as DRAFT — quantities only increase when an authorized officer posts the entry.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Purchase request</Label>
            <Select value={v.purchaseRequestId || "none"} onValueChange={onPrChange}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Manual entry</SelectItem>
                {(prs || []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.reqNo}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Supplier</Label>
            <Select value={v.supplierId || "none"} onValueChange={(val) => set("supplierId", val === "none" ? "" : val)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">—</SelectItem>
                {(suppliers || []).map((s: any) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Warehouse</Label>
            <Select value={v.warehouseId || "none"} onValueChange={(val) => set("warehouseId", val === "none" ? "" : val)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Main / default</SelectItem>
                {(warehouses || []).map((w: any) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Invoice no.</Label><Input value={v.invoiceNo} onChange={(e) => set("invoiceNo", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Invoice date</Label><Input type="date" value={v.invoiceDate} onChange={(e) => set("invoiceDate", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Received date</Label><Input type="date" value={v.receivedDate} onChange={(e) => set("receivedDate", e.target.value)} className="h-9" /></div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Items received</Label>
            <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setLines((a) => [...a, { itemId: "", brandModel: "", quantity: 1, unitCost: "", warrantyValue: "", warrantyUnit: "MONTHS", serials: [] }])}>
              <Plus className="h-3 w-3 mr-1" /> Row
            </Button>
          </div>
          <div className="rounded-xl border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-800">
                  <TableHead className="text-[10px] uppercase min-w-44">Item</TableHead>
                  <TableHead className="text-[10px] uppercase w-40">Brand & Model</TableHead>
                  <TableHead className="text-[10px] uppercase text-right w-20">Qty</TableHead>
                  <TableHead className="text-[10px] uppercase text-right w-24">Unit cost ৳</TableHead>
                  <TableHead className="text-[10px] uppercase w-44">Warranty</TableHead>
                  <TableHead className="text-[10px] uppercase w-44">Serial / IMEI</TableHead>
                  <TableHead className="text-[10px] uppercase text-right w-24">Line total</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, i) => {
                  const item = (items || []).find((x: any) => x.id === l.itemId)
                  return (
                    <TableRow key={i}>
                      <TableCell className="p-1.5 min-w-44">
                        <Select value={l.itemId || "none"} onValueChange={(val) => setLines((a) => a.map((x, j) => (j === i ? { ...x, itemId: val === "none" ? "" : val } : x)))}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select item…" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none" disabled>Select item…</SelectItem>
                            {(items || []).map((x: any) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="p-1.5 min-w-36">
                        <Input
                          value={l.brandModel || ""}
                          onChange={(e) => setLines((a) => a.map((x, j) => (j === i ? { ...x, brandModel: e.target.value } : x)))}
                          placeholder="e.g. Dell / HP / Asus"
                          className="h-8 text-xs"
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Input
                          type="number"
                          min={1}
                          value={l.quantity}
                          onChange={(e) => setLines((a) => a.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                          className="h-8 text-xs tabular-nums w-16"
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Input
                          type="number"
                          value={l.unitCost}
                          onChange={(e) => setLines((a) => a.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))}
                          className="h-8 text-xs tabular-nums w-20"
                          placeholder={String(item?.unitCost ?? 0)}
                        />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={0}
                            value={l.warrantyValue ?? ""}
                            onChange={(e) => setLines((a) => a.map((x, j) => (j === i ? { ...x, warrantyValue: e.target.value } : x)))}
                            placeholder="0"
                            className="h-8 text-xs w-14 tabular-nums"
                          />
                          <Select
                            value={l.warrantyUnit || "MONTHS"}
                            onValueChange={(val) => setLines((a) => a.map((x, j) => (j === i ? { ...x, warrantyUnit: val } : x)))}
                          >
                            <SelectTrigger className="h-8 text-xs w-24">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="DAYS">Days</SelectItem>
                              <SelectItem value="MONTHS">Months</SelectItem>
                              <SelectItem value="YEARS">Years</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </TableCell>
                      <TableCell className="p-1.5">
                        {Number(l.quantity) <= 1 ? (
                          <Input
                            value={l.serials?.[0] || ""}
                            onChange={(e) => {
                              const val = e.target.value
                              setLines((a) => a.map((x, j) => (j === i ? { ...x, serials: val ? [val] : [] } : x)))
                            }}
                            placeholder="Serial / IMEI"
                            className="h-8 text-xs font-mono"
                          />
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs w-full flex items-center justify-between font-normal border-dashed bg-white dark:bg-slate-900"
                            onClick={() => setSerialModalIndex(i)}
                          >
                            <span className="truncate">
                              {l.serials?.filter(Boolean).length
                                ? `${l.serials.filter(Boolean).length}/${l.quantity} serials`
                                : `Add ${l.quantity} serials`}
                            </span>
                            <Barcode className="h-3.5 w-3.5 ml-1 shrink-0 text-slate-400" />
                          </Button>
                        )}
                      </TableCell>
                      <TableCell className="p-1.5 text-xs text-right tabular-nums whitespace-nowrap">{fmtMoney(Number(l.quantity) * Number(l.unitCost || 0))}</TableCell>
                      <TableCell className="p-1.5 text-right">
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" disabled={lines.length <= 1}
                          onClick={() => setLines((a) => a.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Create draft entry"}</Button>
        </DialogFooter>
      </DialogContent>

      {serialModalIndex !== null && lines[serialModalIndex] && (
        <ManageSerialsDialog
          itemName={(items || []).find((x: any) => x.id === lines[serialModalIndex].itemId)?.name || "Item"}
          quantity={Math.max(1, Number(lines[serialModalIndex].quantity) || 1)}
          initialSerials={lines[serialModalIndex].serials || []}
          onSave={(serials) => {
            setLines((a) => a.map((x, j) => (j === serialModalIndex ? { ...x, serials } : x)))
          }}
          onClose={() => setSerialModalIndex(null)}
        />
      )}
    </Dialog>
  )
}

// ================= TRANSACTIONS LEDGER =================
function TransactionsTab() {
  const [type, setType] = useState("")
  const [selectedTx, setSelectedTx] = useState<any>(null)
  const { data, loading, error } = useApi<any[]>("inventory.transactions.list", type ? { type } : {})

  const columns: Column<any>[] = [
    {
      key: "createdAt",
      label: "When",
      sortValue: (t) => t.createdAt,
      render: (t) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDateTime(t.createdAt)}</span>,
    },
    {
      key: "type",
      label: "Type",
      sortValue: (t) => t.type,
      render: (t) => {
        let badgeCls = "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200"
        if (t.type === "ENTRY" || t.type === "TRANSFER_IN") {
          badgeCls = "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200"
        } else if (t.type === "ISSUE" || t.type === "TRANSFER_OUT") {
          badgeCls = "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-200"
        } else if (t.type === "ADJUST") {
          badgeCls = "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 border-sky-200"
        }
        return (
          <Badge variant="outline" className={`text-[10px] font-semibold whitespace-nowrap ${badgeCls}`}>
            {t.type?.replace(/_/g, " ")}
          </Badge>
        )
      },
    },
    {
      key: "itemName",
      label: "Item",
      sortValue: (t) => t.itemName,
      searchValue: (t) => `${t.itemName} ${t.itemCode || ""}`,
      render: (t) => (
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{t.itemName || "—"}</p>
          {t.itemCode && <p className="text-[10px] font-mono text-slate-400">{t.itemCode}</p>}
        </div>
      ),
    },
    {
      key: "warehouseName",
      label: "Warehouse",
      sortValue: (t) => t.warehouseName,
      render: (t) => (
        <span className="text-xs text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">
          {t.warehouseName || "—"}
        </span>
      ),
    },
    {
      key: "quantity",
      label: "Qty",
      align: "right",
      sortValue: (t) => t.quantity,
      render: (t) => (
        <span className={`text-xs font-bold tabular-nums whitespace-nowrap ${t.quantity > 0 ? "text-emerald-600" : "text-rose-600"}`}>
          {t.quantity > 0 ? "+" : ""}{t.quantity} <span className="text-slate-400 font-normal text-[11px]">{t.itemUnit || "Pcs"}</span>
        </span>
      ),
    },
    {
      key: "movement",
      label: "Stock After",
      align: "right",
      render: (t) => {
        const prev = t.previousQty != null ? t.previousQty : "—"
        const next = t.newQty != null ? t.newQty : (t.balanceAfter ?? "—")
        return (
          <span className="text-xs tabular-nums text-slate-500 whitespace-nowrap">
            {prev} → <span className="font-semibold text-slate-800 dark:text-slate-200">{next}</span>
          </span>
        )
      },
    },
    {
      key: "reference",
      label: "Reference",
      render: (t) => {
        const refNo = t.referenceNo || t.refId
        const refType = t.referenceType || t.refType
        return refNo ? (
          <Badge variant="outline" className="text-[10px] font-mono whitespace-nowrap bg-slate-50 dark:bg-slate-900">
            {refType ? `${refType.replace(/_/g, " ")}: ` : ""}{refNo}
          </Badge>
        ) : (
          <span className="text-[10px] text-slate-400">{refType || "manual"}</span>
        )
      },
    },
    {
      key: "userName",
      label: "By",
      render: (t) => <span className="text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">{t.userName || t.byUserName || "system"}</span>,
    },
    {
      key: "remarks",
      label: "Remarks",
      render: (t) => {
        const text = t.remarks || t.note
        return (
          <span className="text-[11px] text-slate-500 max-w-44 truncate block" title={text || undefined}>
            {text || "—"}
          </span>
        )
      },
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (t) => (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          onClick={(e) => {
            e.stopPropagation()
            setSelectedTx(t)
          }}
          title="View Transaction Details"
        >
          <Eye className="h-4 w-4" />
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={type || "all"} onValueChange={(v) => setType(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All movements</SelectItem>
            <SelectItem value="ENTRY">Entries (Goods Receipt)</SelectItem>
            <SelectItem value="ISSUE">Issues (Dispatched/Asset)</SelectItem>
            <SelectItem value="TRANSFER">Transfers between warehouses</SelectItem>
            <SelectItem value="ADJUST">Manual Adjustments</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-slate-400 hidden sm:block">Click any row or the eye icon for complete transaction details</span>
      </div>
      <DataTable
        columns={columns}
        rows={data ?? undefined}
        loading={loading}
        error={error}
        pageSize={15}
        csvName="stock-transactions"
        onRowClick={(tx) => setSelectedTx(tx)}
        searchPlaceholder="Search item name or code…"
        emptyTitle="No stock movements"
        emptyHint="Every quantity change appears here with its before/after values and complete audit trail."
      />

      {selectedTx && (
        <TransactionDetailDialog
          tx={selectedTx}
          onClose={() => setSelectedTx(null)}
        />
      )}
    </div>
  )
}

function TransactionDetailDialog({ tx, onClose }: { tx: any; onClose: () => void }) {
  const isPositive = Number(tx.quantity) > 0
  const prev = tx.previousQty != null ? tx.previousQty : "—"
  const cur = tx.newQty != null ? tx.newQty : (tx.balanceAfter ?? "—")
  const refNo = tx.referenceNo || tx.refId
  const refType = tx.referenceType || tx.refType
  const remarks = tx.remarks || tx.note

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle className="text-base flex items-center gap-2">
              <History className="h-5 w-5 text-sky-600" />
              <span>Stock Transaction Detail</span>
            </DialogTitle>
            <Badge
              variant="outline"
              className={`text-xs font-semibold ${
                tx.type === "ENTRY" || tx.type === "TRANSFER_IN"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300"
                  : tx.type === "ISSUE" || tx.type === "TRANSFER_OUT"
                  ? "bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-300"
                  : "bg-sky-50 text-sky-700 border-sky-300 dark:bg-sky-950 dark:text-sky-300"
              }`}
            >
              {tx.type?.replace(/_/g, " ")}
            </Badge>
          </div>
          <DialogDescription className="text-xs">
            Recorded on {fmtDateTime(tx.createdAt)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-1">
          {/* Item & Warehouse Banner */}
          <div className="p-3 rounded-xl border bg-slate-50/70 dark:bg-slate-900/40 space-y-2">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Item</p>
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{tx.itemName || "—"}</p>
                {tx.itemCode && <p className="text-xs font-mono text-slate-400">{tx.itemCode} · {tx.itemCategory || "Category"}</p>}
              </div>
              <div className="text-right">
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Warehouse</p>
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1 justify-end">
                  <Warehouse className="h-3.5 w-3.5 text-slate-400" />
                  {tx.warehouseName || "—"}
                </p>
              </div>
            </div>
          </div>

          {/* Movement Metrics */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-xl border bg-white dark:bg-slate-900 space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Quantity Changed</p>
              <p className={`text-xl font-bold tabular-nums ${isPositive ? "text-emerald-600" : "text-rose-600"}`}>
                {isPositive ? "+" : ""}{tx.quantity} <span className="text-xs font-normal text-slate-500">{tx.itemUnit || "Pcs"}</span>
              </p>
            </div>
            <div className="p-3 rounded-xl border bg-white dark:bg-slate-900 space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Stock Balance</p>
              <p className="text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                {prev} → <span className="text-base font-bold text-slate-900 dark:text-slate-100">{cur}</span> {tx.itemUnit || "Pcs"}
              </p>
            </div>
          </div>

          {/* Reference & Performed By */}
          <div className="rounded-xl border divide-y text-xs">
            <div className="flex items-center justify-between p-2.5">
              <span className="text-slate-500 font-medium">Reference</span>
              <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                {refNo ? `${refType ? `${refType}: ` : ""}${refNo}` : "Manual Action"}
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5">
              <span className="text-slate-500 font-medium">Performed By</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {tx.userName || tx.byUserName || "System"}
              </span>
            </div>
            {tx.unitCost != null && tx.unitCost > 0 && (
              <div className="flex items-center justify-between p-2.5">
                <span className="text-slate-500 font-medium">Unit Cost</span>
                <span className="font-medium tabular-nums text-slate-800 dark:text-slate-200">
                  {fmtMoney(tx.unitCost)}
                </span>
              </div>
            )}
            <div className="p-2.5 space-y-1">
              <span className="text-slate-500 font-medium block">Remarks / Notes</span>
              <p className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 p-2 rounded-lg text-xs leading-relaxed">
                {remarks || "No remarks provided"}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

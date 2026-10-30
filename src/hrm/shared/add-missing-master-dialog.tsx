"use client"
// ============ Add Missing Master Dialog (Item / Category / Unit) ============
// Allows employees or procurement requesters to request a missing Item,
// Category, or Unit during Goods Requisition creation. Submitting sends an
// approval request to the unified Approval Queue, which automatically creates
// the master record upon approval.
import { useEffect, useState } from "react"
import { Lock, PackagePlus, Loader2, Send, Tags, Scale, Package } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { rpc, useApi } from "../api"
import { useHrm } from "../store"

export type MasterRequestType = "ITEM" | "CATEGORY" | "UNIT"

export function AddMissingMasterDialog({
  open,
  onClose,
  initialType = "ITEM",
  onSuccess,
}: {
  open: boolean
  onClose: () => void
  initialType?: MasterRequestType
  onSuccess?: (type: MasterRequestType, name: string) => void
}) {
  const toast = useHrm((s) => s.toast)
  const { data: categories } = useApi<any[]>("inventory.categories.list", {})
  const { data: units } = useApi<any[]>("inventory.units.list", {})

  const activeCategories = (categories || []).filter((c) => c.active !== false)
  const activeUnits = (units || []).filter((u) => u.active !== false)

  const [type, setType] = useState<MasterRequestType>(initialType)

  // Form states
  const [v, setV] = useState({
    name: "",
    category: "",
    unit: "",
    unitCost: "",
    reorderLevel: "",
    brandModel: "",
    hasWarranty: false,
    isReturnable: false,
    description: "",
    symbol: "",
    remarks: "",
  })

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const set = (key: string, val: any) => setV((s) => ({ ...s, [key]: val }))

  // Reset or initialize on open
  useEffect(() => {
    if (open) {
      setType(initialType)
      setV({
        name: "",
        category: activeCategories[0]?.name || "IT",
        unit: activeUnits[0]?.symbol || activeUnits[0]?.name || "Pcs",
        unitCost: "",
        reorderLevel: "",
        brandModel: "",
        hasWarranty: false,
        isReturnable: false,
        description: "",
        symbol: "",
        remarks: "",
      })
      setErr(null)
    }
  }, [open, initialType])

  // Set default category / unit when loaded
  useEffect(() => {
    if (!v.category && activeCategories.length > 0) {
      set("category", activeCategories[0].name)
    }
  }, [activeCategories, v.category])

  useEffect(() => {
    if (!v.unit && activeUnits.length > 0) {
      set("unit", activeUnits[0].symbol || activeUnits[0].name)
    }
  }, [activeUnits, v.unit])

  const submit = async () => {
    if (!v.name.trim()) {
      setErr(`${type === "ITEM" ? "Item" : type === "CATEGORY" ? "Category" : "Unit"} name is required`)
      return
    }

    setBusy(true)
    setErr(null)
    try {
      await rpc<any>("inventory.masterRequest.create", {
        type,
        name: v.name.trim(),
        category: v.category || (activeCategories[0]?.name ?? "OTHER"),
        unit: v.unit || (activeUnits[0]?.symbol ?? "Pcs"),
        unitCost: v.unitCost ? Number(v.unitCost) : 0,
        reorderLevel: v.reorderLevel ? Number(v.reorderLevel) : 0,
        brandModel: v.brandModel.trim() || null,
        hasWarranty: v.hasWarranty,
        isReturnable: v.isReturnable,
        description: v.description.trim() || null,
        symbol: v.symbol.trim() || null,
        remarks: v.remarks.trim() || null,
      })

      const typeLabel = type === "ITEM" ? "item" : type === "CATEGORY" ? "category" : "unit"
      toast(`Request to add ${typeLabel} "${v.name.trim()}" sent for approval`)
      onSuccess?.(type, v.name.trim())
      onClose()
    } catch (e: any) {
      setErr(e.message || "Failed to submit request for approval")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && !v && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <PackagePlus className="h-4.5 w-4.5 text-emerald-600" />
            Add Missing {type === "ITEM" ? "Item" : type === "CATEGORY" ? "Category" : "Unit"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Select whether you want to request an Item, Category, or Unit. The request will be submitted for approval and added upon authorization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-1">
          {/* Request Type Selector */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Adding Type <span className="text-rose-500">*</span>
            </Label>
            <Select value={type} onValueChange={(val: MasterRequestType) => { setType(val); setErr(null) }}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select type to add…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ITEM">
                  <div className="flex items-center gap-2">
                    <Package className="h-3.5 w-3.5 text-emerald-600" />
                    <span>Item (Stock / Goods)</span>
                  </div>
                </SelectItem>
                <SelectItem value="CATEGORY">
                  <div className="flex items-center gap-2">
                    <Tags className="h-3.5 w-3.5 text-emerald-600" />
                    <span>Category</span>
                  </div>
                </SelectItem>
                <SelectItem value="UNIT">
                  <div className="flex items-center gap-2">
                    <Scale className="h-3.5 w-3.5 text-emerald-600" />
                    <span>Unit of Measurement</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* DYNAMIC FIELDS: ITEM */}
          {type === "ITEM" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-slate-100 dark:border-slate-800">
              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-xs font-medium">Name <span className="text-rose-500">*</span></Label>
                <Input
                  value={v.name}
                  onChange={(e) => set("name", e.target.value)}
                  className="h-9 text-xs"
                  placeholder="e.g. Wireless Mouse, Laptop"
                />
              </div>

              <div className="space-y-1.5 sm:col-span-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">Item Code</Label>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 flex items-center gap-1 font-medium">
                    <Lock className="h-2.5 w-2.5" /> Auto-locked
                  </span>
                </div>
                <Input
                  value="Auto-generated on approval"
                  disabled
                  readOnly
                  className="h-9 font-mono text-xs cursor-not-allowed bg-slate-100 dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700 select-none"
                  title="Sequential item code will be auto-assigned when this request is approved"
                />
              </div>

              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-xs font-medium">Category</Label>
                <Select value={v.category} onValueChange={(val) => set("category", val)}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select category…" /></SelectTrigger>
                  <SelectContent>
                    {activeCategories.length > 0 ? (
                      activeCategories.map((c) => (
                        <SelectItem key={c.id || c.name} value={c.name}>{c.name}</SelectItem>
                      ))
                    ) : (
                      <>
                        <SelectItem value="IT">IT</SelectItem>
                        <SelectItem value="FURNITURE">Furniture</SelectItem>
                        <SelectItem value="STATIONERY">Stationery</SelectItem>
                        <SelectItem value="OTHER">Other</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-xs font-medium">Unit</Label>
                <Select value={v.unit} onValueChange={(val) => set("unit", val)}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select unit…" /></SelectTrigger>
                  <SelectContent>
                    {activeUnits.length > 0 ? (
                      activeUnits.map((u) => (
                        <SelectItem key={u.id || u.symbol || u.name} value={u.symbol || u.name}>
                          {u.name} {u.symbol && u.symbol !== u.name ? `(${u.symbol})` : ""}
                        </SelectItem>
                      ))
                    ) : (
                      <>
                        <SelectItem value="Pcs">Pieces (Pcs)</SelectItem>
                        <SelectItem value="Box">Box</SelectItem>
                        <SelectItem value="Set">Set</SelectItem>
                        <SelectItem value="Kg">Kilogram (Kg)</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-xs font-medium">Unit cost (৳)</Label>
                <Input
                  type="number"
                  value={v.unitCost}
                  onChange={(e) => set("unitCost", e.target.value)}
                  className="h-9 text-xs tabular-nums"
                  placeholder="0"
                />
              </div>

              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-xs font-medium">Reorder level</Label>
                <Input
                  type="number"
                  value={v.reorderLevel}
                  onChange={(e) => set("reorderLevel", e.target.value)}
                  className="h-9 text-xs tabular-nums"
                  placeholder="0"
                />
              </div>


              <div className="col-span-1 sm:col-span-2 space-y-1.5 pt-1 border-t border-slate-100 dark:border-slate-800">
                <Label className="text-xs font-medium">Is it returnable to company during holder&apos;s leave from company?</Label>
                <div className="flex items-center justify-between h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                  <span className="text-xs text-slate-600 dark:text-slate-300">
                    {v.isReturnable
                      ? "Yes — Used for company asset tracking & issued as asset to employees"
                      : "No — Consumable / Non-returnable item"}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch checked={v.isReturnable} onCheckedChange={(c) => set("isReturnable", c)} id="missing-isReturnable" />
                    <Label htmlFor="missing-isReturnable" className="text-xs cursor-pointer select-none font-semibold min-w-8">
                      {v.isReturnable ? "Yes" : "No"}
                    </Label>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* DYNAMIC FIELDS: CATEGORY */}
          {type === "CATEGORY" && (
            <div className="space-y-3 pt-1 border-t border-slate-100 dark:border-slate-800">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Category name <span className="text-rose-500">*</span></Label>
                <Input
                  value={v.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. IT, FURNITURE, MEDICAL, PANTRY"
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Description</Label>
                <Input
                  value={v.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="e.g. Office pantry, cleaning materials & kitchen consumables"
                  className="h-9 text-xs"
                />
              </div>
            </div>
          )}

          {/* DYNAMIC FIELDS: UNIT */}
          {type === "UNIT" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-slate-100 dark:border-slate-800">
              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-xs font-medium">Unit name <span className="text-rose-500">*</span></Label>
                <Input
                  value={v.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. Packet, Dozen, Ream, Roll"
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-1">
                <Label className="text-xs font-medium">Symbol / Short code</Label>
                <Input
                  value={v.symbol}
                  onChange={(e) => set("symbol", e.target.value)}
                  placeholder="e.g. pkt, doz, rm, roll"
                  className="h-9 text-xs font-mono"
                />
              </div>
            </div>
          )}

          {/* Reason / Remarks (Audit trail) */}
          <div className="space-y-1.5 pt-1">
            <Label className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Reason / Purpose of request (optional)
            </Label>
            <Input
              value={v.remarks}
              onChange={(e) => set("remarks", e.target.value)}
              placeholder="e.g. Needed for urgent goods requisition"
              className="h-8 text-xs"
            />
          </div>
        </div>

        {err && (
          <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 rounded-md px-3 py-2">
            {err}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0 pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || !v.name.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

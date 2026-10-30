"use client"
// ============ Goods Requisition dialog — shared by ESS (My Self-Service) and
// the Requisition & Purchase module (HR creating on behalf of an employee).
// Consolidated single source of truth for goods requisitions across the application.
import { useEffect, useState } from "react"
import { Plus, Trash2, PackagePlus, Search, ChevronsUpDown, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { rpc, useApi, useLookup } from "../api"
import { useHrm } from "../store"
import { AddMissingMasterDialog } from "./add-missing-master-dialog"

export type RequisitionLine = {
  itemId: string
  itemName: string
  itemCategory: string
  specification: string
  quantity: number | string
  unit: string
  remarks: string
}

export function GoodsRequisitionDialog({
  open,
  onOpenChange,
  employees: employeesProp,
  initial,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** HR on-behalf picker options; if omitted for HR users, actively fetched */
  employees?: { id: string; fullName: string; code: string; designationName?: string | null }[]
  /** requisitions.get payload for edit mode */
  initial?: any
  onSaved?: () => void
}) {
  const { user, can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const isEmployee = user?.role === "EMPLOYEE"
  const { data: lookupEmployees } = useLookup<any[]>(
    "employees.list",
    { status: "ACTIVE" },
    open && !isEmployee && !employeesProp && can("employees", "view")
  )
  const allEmployees = employeesProp || lookupEmployees || []

  const { data: items, reload: reloadItems } = useApi<any[]>("inventory.items.list", {})
  const { data: categories, reload: reloadCategories } = useApi<any[]>("inventory.categories.list", {})
  const { data: units, reload: reloadUnits } = useApi<any[]>("inventory.units.list", {})
  const { data: me } = useApi<any>(open && isEmployee ? "ess.profile" : null, {})

  const activeCategories = (categories || []).filter((c: any) => c.active !== false)
  const activeUnits = (units || []).filter((u: any) => u.active !== false)

  const [employeeId, setEmployeeId] = useState("")
  const [empOpen, setEmpOpen] = useState(false)
  const [priority, setPriority] = useState("NORMAL")
  const [requiredDate, setRequiredDate] = useState("")
  const [purpose, setPurpose] = useState("")
  const [lines, setLines] = useState<RequisitionLine[]>([
    { itemCategory: "IT", itemId: "", itemName: "", specification: "", quantity: 1, unit: "Pcs", remarks: "" },
  ])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [missingMasterOpen, setMissingMasterOpen] = useState(false)

  const selectedEmp = allEmployees.find((e: any) => e.id === employeeId)

  // Initialize or reset form state on open
  useEffect(() => {
    if (!open) return
    setErr(null)
    if (initial?.id) {
      const req = initial.requisition || initial
      setEmployeeId(req.employeeId || "")
      setPriority(req.priority === "URGENT" ? "URGENT" : "NORMAL")
      setRequiredDate(req.requiredDate || "")
      setPurpose(req.purpose || "")
      setLines(
        (initial.items || []).map((it: any) => ({
          itemId: it.itemId || "",
          itemName: it.itemName || "",
          itemCategory: it.itemCategory || it.category || "OTHER",
          specification: it.specification || "",
          quantity: it.quantity ?? 1,
          unit: it.unit || "Pcs",
          remarks: it.remarks || "",
        }))
      )
    } else {
      if (isEmployee && me?.employee?.id) {
        setEmployeeId(me.employee.id)
      } else {
        setEmployeeId("")
      }
      setPriority("NORMAL")
      setRequiredDate("")
      setPurpose("")
      setLines([
        {
          itemCategory: activeCategories[0]?.name || "IT",
          itemId: "",
          itemName: "",
          specification: "",
          quantity: 1,
          unit: activeUnits[0]?.symbol || activeUnits[0]?.name || "Pcs",
          remarks: "",
        },
      ])
    }
  }, [open, initial, isEmployee, me])

  // Update employeeId if me loads after dialog is already open
  useEffect(() => {
    if (open && isEmployee && me?.employee?.id && !employeeId) {
      setEmployeeId(me.employee.id)
    }
  }, [open, isEmployee, me, employeeId])

  const setLine = (i: number, key: keyof RequisitionLine, val: any) =>
    setLines((a) => a.map((x, j) => (j === i ? { ...x, [key]: val } : x)))

  const onPickItem = (i: number, itemId: string) => {
    const chosen = (items || []).find((x: any) => x.id === itemId)
    setLines((a) =>
      a.map((x, j) =>
        j === i
          ? {
              ...x,
              itemId,
              itemName: chosen?.name || "",
              itemCategory: chosen?.category || "OTHER",
              unit: chosen?.unit || x.unit || "Pcs",
            }
          : x
      )
    )
  }

  const submitForm = async (submitForApproval: boolean) => {
    setErr(null)
    const target = isEmployee ? me?.employee?.id || employeeId : employeeId
    if (!target) {
      setErr("Select the requesting employee")
      return
    }
    const clean = lines.filter((l) => l.itemId && Number(l.quantity) > 0)
    if (!clean.length) {
      setErr("Add at least one item from inventory with a positive quantity")
      return
    }
    setBusy(true)
    try {
      const chosenItem = (id: string) => (items || []).find((x: any) => x.id === id)
      const payloadItems = clean.map((l) => {
        const itemObj = chosenItem(l.itemId)
        return {
          itemId: l.itemId,
          itemCategory: itemObj?.category || l.itemCategory || "OTHER",
          itemName: itemObj?.name || l.itemName,
          specification: l.specification || null,
          quantity: Number(l.quantity),
          unit: l.unit || itemObj?.unit || "Pcs",
          remarks: l.remarks || null,
        }
      })

      if (initial?.id) {
        await rpc("requisitions.update", {
          id: initial.id,
          requiredDate: requiredDate || null,
          priority,
          purpose: purpose || null,
          items: payloadItems,
          submit: submitForApproval,
        })
        toast(submitForApproval ? "Requisition updated and submitted for approval" : "Requisition draft updated")
      } else {
        const rec = await rpc<any>("requisitions.create", {
          employeeId: target,
          priority,
          requiredDate: requiredDate || null,
          purpose: purpose || null,
          submit: submitForApproval,
          items: payloadItems,
        })
        toast(`Requisition ${rec.reqNo} created${submitForApproval ? " and submitted for approval" : " as draft"}`)
      }
      onOpenChange(false)
      onSaved?.()
    } catch (e: any) {
      setErr(e.message || "Failed to save requisition")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <PackagePlus className="h-4.5 w-4.5 text-emerald-600" />
            {initial?.id ? `Edit Requisition — ${initial.requisition?.reqNo || ""}` : "New Goods Requisition"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Request office goods — the workflow routes it for approval; stock is checked automatically upon approval.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {!isEmployee && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Requesting employee <span className="text-rose-500">*</span></Label>
              <Popover open={empOpen} onOpenChange={setEmpOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    role="combobox"
                    aria-expanded={empOpen}
                    aria-controls="goods-req-employee-list"
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-xs text-left flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span className={`truncate ${selectedEmp ? "text-slate-800 dark:text-slate-200 font-medium" : "text-slate-400"}`}>
                        {selectedEmp ? `${selectedEmp.fullName}${selectedEmp.code ? ` (${selectedEmp.code})` : ""}` : "Search & select employee…"}
                      </span>
                    </div>
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50 ml-1" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[320px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search employee name or code…" className="h-8 text-xs" />
                    <CommandList className="max-h-56">
                      <CommandEmpty className="text-xs py-3 text-center">No employee found.</CommandEmpty>
                      <CommandGroup>
                        {allEmployees.map((e: any) => (
                          <CommandItem
                            key={e.id}
                            value={`${e.fullName} ${e.code || ""}`}
                            onSelect={() => {
                              setEmployeeId(e.id)
                              setEmpOpen(false)
                            }}
                            className="text-xs flex items-center gap-2 cursor-pointer"
                          >
                            <Check className={`h-3.5 w-3.5 shrink-0 ${employeeId === e.id ? "opacity-100" : "opacity-0"}`} />
                            <span className="truncate">{e.fullName}</span>
                            {e.code && <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400 shrink-0">{e.code}</span>}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="NORMAL">Normal</SelectItem>
                <SelectItem value="URGENT">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Required date</Label>
            <Input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} className="h-9" />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Purpose / remarks</Label>
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} className="h-9" placeholder="e.g. New joiner workstation setup" />
          </div>
        </div>

        {/* ---------- Items table ---------- */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Items</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px] bg-white dark:bg-slate-900 border-dashed border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                onClick={() => setMissingMasterOpen(true)}
              >
                <PackagePlus className="h-3.5 w-3.5 mr-1 text-emerald-600" />
                Add missing Item/Category/Unit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px] bg-white dark:bg-slate-900"
                onClick={() =>
                  setLines((a) => [
                    ...a,
                    {
                      itemCategory: activeCategories[0]?.name || "IT",
                      itemId: "",
                      itemName: "",
                      specification: "",
                      quantity: 1,
                      unit: activeUnits[0]?.symbol || activeUnits[0]?.name || "Pcs",
                      remarks: "",
                    },
                  ])
                }
              >
                <Plus className="h-3 w-3 mr-1" /> Row
              </Button>
            </div>
          </div>

          <div className="rounded-xl border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-800">
                  <TableHead className="text-[10px] uppercase min-w-52">Inventory item *</TableHead>
                  <TableHead className="text-[10px] uppercase w-32">Category</TableHead>
                  <TableHead className="text-[10px] uppercase">Specification</TableHead>
                  <TableHead className="text-[10px] uppercase w-20">Qty</TableHead>
                  <TableHead className="text-[10px] uppercase w-28">Unit</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell className="p-1.5 min-w-52">
                      <Select value={l.itemId || ""} onValueChange={(v) => onPickItem(i, v)}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Select inventory item…" />
                        </SelectTrigger>
                        <SelectContent>
                          {(items || []).filter((x: any) => x.active).map((x: any) => (
                            <SelectItem key={x.id} value={x.id}>
                              {x.name} ({x.onHand} {x.unit} on hand){x.isReturnable ? " · Returnable Asset" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="p-1.5 min-w-28">
                      <div className="h-8 px-2.5 flex items-center text-xs text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/60 rounded border border-slate-200 dark:border-slate-800">
                        {l.itemCategory || (l.itemId ? (items || []).find((x: any) => x.id === l.itemId)?.category : "—") || "—"}
                      </div>
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Input
                        value={l.specification}
                        onChange={(e) => setLine(i, "specification", e.target.value)}
                        className="h-8 text-xs"
                        placeholder="e.g. Core i5, 16GB RAM"
                      />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Input
                        type="number"
                        min={1}
                        value={l.quantity}
                        onChange={(e) => setLine(i, "quantity", e.target.value)}
                        className="h-8 text-xs w-20 tabular-nums"
                      />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Select value={l.unit || "Pcs"} onValueChange={(v) => setLine(i, "unit", v)}>
                        <SelectTrigger className="h-8 text-xs w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {activeUnits.length > 0 ? (
                            activeUnits.map((u: any) => (
                              <SelectItem key={u.id || u.symbol || u.name} value={u.symbol || u.name}>
                                {u.name} {u.symbol && u.symbol !== u.name ? `(${u.symbol})` : ""}
                              </SelectItem>
                            ))
                          ) : (
                            <>
                              <SelectItem value="Pcs">Pcs</SelectItem>
                              <SelectItem value="Box">Box</SelectItem>
                              <SelectItem value="Set">Set</SelectItem>
                              <SelectItem value="Kg">Kg</SelectItem>
                            </>
                          )}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="p-1.5 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-slate-400 hover:text-rose-600"
                        disabled={lines.length <= 1}
                        onClick={() => setLines((a) => a.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          {!initial?.id && (
            <Button variant="outline" onClick={() => submitForm(false)} disabled={busy} className="bg-white dark:bg-slate-900">
              {busy ? "Saving…" : "Save draft"}
            </Button>
          )}
          <Button onClick={() => submitForm(true)} disabled={busy}>
            {busy ? "Submitting…" : initial?.id ? "Update & Submit" : "Submit for approval"}
          </Button>
        </DialogFooter>

        {missingMasterOpen && (
          <AddMissingMasterDialog
            open
            onClose={() => setMissingMasterOpen(false)}
            onSuccess={() => {
              reloadItems()
              reloadCategories()
              reloadUnits()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

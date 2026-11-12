"use client"
// Transfer an employee to another company of the same organization.
// History stays with the current company: see src/hrm-server/company-transfer.ts.
import { useEffect, useState } from "react"
import { AlertTriangle, ArrowLeftRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useHrm } from "../store"
import { rpc, useApi } from "../api"

type Named = { id: string; name: string }
type Options = { branches: Named[]; departments: Named[]; designations: Named[]; shifts: Named[]; managers: { id: string; fullName: string; code: string }[] }

const NONE = "__none__"

function Picker({ label, value, onChange, items, required }: { label: string; value: string; onChange: (v: string) => void; items: { id: string; name: string }[]; required?: boolean }) {
  return (
    <div>
      <Label className="text-xs font-medium">{label}{required ? " *" : ""}</Label>
      <Select value={value || (required ? undefined : NONE)} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
        <SelectTrigger className="mt-1 h-9 text-xs"><SelectValue placeholder="Select…" /></SelectTrigger>
        <SelectContent>
          {!required && <SelectItem value={NONE} className="text-xs">None</SelectItem>}
          {items.map((i) => <SelectItem key={i.id} value={i.id} className="text-xs">{i.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

export function CompanyTransferDialog({ employee, open, onOpenChange, onDone }: {
  employee: { id: string; fullName: string; code: string; companyId?: string | null }
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const activeCompanyId = useHrm((s) => s.activeCompanyId)
  const { data: companies } = useApi<Named[]>(open ? "companies.options" : null, {})
  const destinations = (companies || []).filter((c) => c.id !== (employee.companyId || activeCompanyId))
  const [toCompanyId, setToCompanyId] = useState("")
  const [options, setOptions] = useState<Options | null>(null)
  const [form, setForm] = useState({ toBranchId: "", toDepartmentId: "", toDesignationId: "", toShiftId: "", toManagerId: "", toCode: "", effectiveDate: "", reason: "", carryLeaveBalances: true })
  const [blockers, setBlockers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  useEffect(() => {
    setOptions(null)
    setForm((f) => ({ ...f, toBranchId: "", toDepartmentId: "", toDesignationId: "", toShiftId: "", toManagerId: "" }))
    if (!toCompanyId) return
    let cancelled = false
    rpc<Options>("companyTransfer.destinationOptions", { companyId: toCompanyId })
      .then((o) => { if (!cancelled) setOptions(o) })
      .catch((e) => toast(e.message, "err"))
    return () => { cancelled = true }
  }, [toCompanyId, toast])

  useEffect(() => {
    setBlockers([])
    if (!open || !form.effectiveDate) return
    let cancelled = false
    rpc<{ blockers: string[] }>("companyTransfer.preflight", { employeeId: employee.id, effectiveDate: form.effectiveDate })
      .then((r) => { if (!cancelled) setBlockers(r.blockers) })
      .catch((e) => toast(e.message, "err"))
    return () => { cancelled = true }
  }, [open, form.effectiveDate, employee.id, toast])

  const ready = toCompanyId && form.toBranchId && form.effectiveDate && form.reason.trim().length >= 3 && !blockers.length

  const submit = async () => {
    setBusy(true)
    try {
      await rpc("companyTransfer.request", {
        employeeId: employee.id, toCompanyId, toBranchId: form.toBranchId,
        toDepartmentId: form.toDepartmentId || null, toDesignationId: form.toDesignationId || null,
        toShiftId: form.toShiftId || null, toManagerId: form.toManagerId || null,
        ...(form.toCode.trim() ? { toCode: form.toCode.trim() } : {}),
        effectiveDate: form.effectiveDate, reason: form.reason.trim(), carryLeaveBalances: form.carryLeaveBalances,
      })
      toast("Company transfer sent for approval")
      onOpenChange(false)
      onDone()
    } catch (e: any) {
      toast(e.message, "err")
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2"><ArrowLeftRight className="h-4 w-4 text-sky-600" /> Transfer to Another Company</DialogTitle>
          <DialogDescription className="text-xs">
            {employee.fullName} ({employee.code}). Attendance, leave, payroll and all other history stay with the current company. A new employment record opens in the destination company on the effective date.
          </DialogDescription>
        </DialogHeader>

        {companies && destinations.length === 0 ? (
          <p className="text-xs text-muted-foreground">There is no other active company to transfer to.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Picker label="Destination company" required value={toCompanyId} onChange={setToCompanyId} items={destinations} />
            </div>
            <Picker label="Branch" required value={form.toBranchId} onChange={(v) => set({ toBranchId: v })} items={options?.branches || []} />
            <div>
              <Label className="text-xs font-medium">Effective date *</Label>
              <Input type="date" className="mt-1 h-9 text-xs" value={form.effectiveDate} onChange={(e) => set({ effectiveDate: e.target.value })} />
            </div>
            <Picker label="Department" value={form.toDepartmentId} onChange={(v) => set({ toDepartmentId: v })} items={options?.departments || []} />
            <Picker label="Designation" value={form.toDesignationId} onChange={(v) => set({ toDesignationId: v })} items={options?.designations || []} />
            <Picker label="Shift" value={form.toShiftId} onChange={(v) => set({ toShiftId: v })} items={options?.shifts || []} />
            <Picker label="Reporting manager" value={form.toManagerId} onChange={(v) => set({ toManagerId: v })} items={(options?.managers || []).map((m) => ({ id: m.id, name: `${m.fullName} (${m.code})` }))} />
            <div className="sm:col-span-2">
              <Label className="text-xs font-medium">New employee code</Label>
              <Input className="mt-1 h-9 text-xs" placeholder={`Leave blank to keep ${employee.code}`} value={form.toCode} onChange={(e) => set({ toCode: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs font-medium">Reason *</Label>
              <Textarea rows={2} className="mt-1 text-xs" value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
            </div>
            <label className="sm:col-span-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={form.carryLeaveBalances} onChange={(e) => set({ carryLeaveBalances: e.target.checked })} />
              Carry unused leave to matching leave types in the destination company
            </label>
            {blockers.length > 0 && (
              <div className="sm:col-span-2 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 p-3">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Settle these first</p>
                <ul className="mt-1.5 list-disc pl-4 text-[11px] text-amber-800/90 dark:text-amber-300/90 space-y-0.5">
                  {blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" disabled={!ready || busy} onClick={submit}>{busy ? "Sending…" : "Send for Approval"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

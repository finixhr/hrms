"use client"
// ============ /owner/plans — Plans console (Phase 5 P5 polish) ===========
// §25, polished onto the P0–P4 console design system: gradient header, a
// derived KPI strip (from the loaded plans array — no extra round trip), and
// the duplicate / toggle error paths now show inline toasts instead of
// browser alerts (the P2 zero-alert discipline). The editor dialog was
// already on the shared Dialog component — unchanged.
// 2026-10-25 — CUSTOM PLAN BUILDER section (master prompt Part G §12): a
// tenant picker (owner.tenants.list — same tenants.view perm the customList
// read needs) → owner.plans.customList → per-tenant custom plans table + a
// builder dialog (base-plan defaults, RECURRING | ONE_TIME with an explicit
// fixed-validity / non-expiring choice, limits, all 12 modules, support
// level, assign-now, REQUIRED audit reason) → owner.plans.saveCustom.
import { useCallback, useEffect, useState } from "react"
import { Copy, Loader2, PieChart, Plus, Save, Search, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { ownerRpc, useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, PageHeader, StatusChip, TableShell, Td, Loading } from "@/saas/owner/ui"

type Plan = {
  id: string
  name: string
  tagline: string | null
  description: string | null
  monthlyPrice: number
  yearlyPrice: number
  currency: string
  employeeLimit: number | null
  userLimit: number | null
  branchLimit: number | null
  departmentLimit: number | null
  deviceLimit: number | null
  storageGb: number | null
  trackingEmployeeLimit: number | null
  payrollEnabled: boolean
  aitEnabled: boolean
  inventoryEnabled: boolean
  procurementEnabled: boolean
  performanceEnabled: boolean
  essEnabled: boolean
  cameraEnabled: boolean
  trackingEnabled: boolean
  geofenceEnabled: boolean
  apiAccess: boolean
  advancedReports: boolean
  fieldForceEnabled: boolean
  supportLevel: string
  isPublic: boolean
  active: boolean
  isTrialPlan: boolean
  badge: string | null
  sortOrder: number
  subscriberCount: number
  createdAt: string
  // custom-plan columns (present on every SaasPlan row — owner.plans.list
  // spreads the full model; only relevant for custom/base filtering)
  isCustom?: boolean
  customForVendorId?: string | null
  billingMode?: string | null
  oneTimeValidityDays?: number | null
}

const BLANK = {
  name: "", tagline: "", description: "",
  monthlyPrice: "0", yearlyPrice: "0", currency: "BDT",
  employeeLimit: "", userLimit: "", branchLimit: "", departmentLimit: "", deviceLimit: "", storageGb: "", trackingEmployeeLimit: "",
  payrollEnabled: false, aitEnabled: false, inventoryEnabled: false, procurementEnabled: false,
  performanceEnabled: false, essEnabled: true, cameraEnabled: false, trackingEnabled: false,
  geofenceEnabled: false, apiAccess: false, advancedReports: false, fieldForceEnabled: false,
  supportLevel: "STANDARD", isPublic: true, active: true, isTrialPlan: false, badge: "", sortOrder: "0",
}

type FormState = typeof BLANK & { id?: string }

export default function PlansPage() {
  const { data, loading, error, reload } = useOwnerApi<{ plans: Plan[] }>("owner.plans.list", {})
  const [section, setSection] = useState<"catalog" | "custom">("catalog")
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState<FormState>({ ...BLANK })
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // toasts self-dismiss after 5 s
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5_000)
    return () => clearTimeout(t)
  }, [toast])

  const openNew = () => { setForm({ ...BLANK }); setFormError(null); setEditOpen(true) }
  const openEdit = (p: Plan) => {
    setForm({
      id: p.id, name: p.name, tagline: p.tagline || "", description: p.description || "",
      monthlyPrice: String(Number(p.monthlyPrice)), yearlyPrice: String(Number(p.yearlyPrice)), currency: p.currency,
      employeeLimit: p.employeeLimit?.toString() ?? "", userLimit: p.userLimit?.toString() ?? "",
      branchLimit: p.branchLimit?.toString() ?? "", departmentLimit: p.departmentLimit?.toString() ?? "",
      deviceLimit: p.deviceLimit?.toString() ?? "", storageGb: p.storageGb?.toString() ?? "",
      trackingEmployeeLimit: p.trackingEmployeeLimit?.toString() ?? "",
      payrollEnabled: p.payrollEnabled, aitEnabled: p.aitEnabled, inventoryEnabled: p.inventoryEnabled,
      procurementEnabled: p.procurementEnabled, performanceEnabled: p.performanceEnabled, essEnabled: p.essEnabled,
      cameraEnabled: p.cameraEnabled, trackingEnabled: p.trackingEnabled, geofenceEnabled: p.geofenceEnabled,
      apiAccess: p.apiAccess, advancedReports: p.advancedReports, fieldForceEnabled: p.fieldForceEnabled ?? false,
      supportLevel: p.supportLevel, isPublic: p.isPublic, active: p.active, isTrialPlan: p.isTrialPlan,
      badge: p.badge || "", sortOrder: String(p.sortOrder),
    })
    setFormError(null)
    setEditOpen(true)
  }

  const save = async () => {
    setBusy(true); setFormError(null)
    try {
      const num = (v: string) => (v === "" ? null : Number(v))
      await ownerRpc("owner.plans.save", {
        id: form.id,
        name: form.name,
        tagline: form.tagline || null,
        description: form.description || null,
        monthlyPrice: Number(form.monthlyPrice) || 0,
        yearlyPrice: Number(form.yearlyPrice) || 0,
        currency: form.currency,
        employeeLimit: num(form.employeeLimit), userLimit: num(form.userLimit),
        branchLimit: num(form.branchLimit), departmentLimit: num(form.departmentLimit),
        deviceLimit: num(form.deviceLimit), storageGb: num(form.storageGb),
        trackingEmployeeLimit: num(form.trackingEmployeeLimit),
        payrollEnabled: form.payrollEnabled, aitEnabled: form.aitEnabled, inventoryEnabled: form.inventoryEnabled,
        procurementEnabled: form.procurementEnabled, performanceEnabled: form.performanceEnabled,
        essEnabled: form.essEnabled, cameraEnabled: form.cameraEnabled, trackingEnabled: form.trackingEnabled,
        geofenceEnabled: form.geofenceEnabled, apiAccess: form.apiAccess, advancedReports: form.advancedReports, fieldForceEnabled: form.fieldForceEnabled,
        supportLevel: form.supportLevel as any, isPublic: form.isPublic, active: form.active,
        isTrialPlan: form.isTrialPlan, badge: form.badge || null, sortOrder: Number(form.sortOrder) || 0,
      })
      setEditOpen(false)
      await reload()
    } catch (e: any) {
      setFormError(e?.message || "Save failed.")
    } finally { setBusy(false) }
  }

  const duplicate = async (id: string) => {
    try {
      await ownerRpc("owner.plans.duplicate", { id })
      setToast("Plan duplicated — the copy is listed below and ready to edit.")
      await reload()
    } catch (e: any) { setToast(e?.message || "Duplicate failed") }
  }
  const toggle = async (p: Plan, active: boolean) => {
    try {
      await ownerRpc("owner.plans.toggle", { id: p.id, active })
      setToast(active ? `“${p.name}” activated — assignable to tenants again.` : `“${p.name}” deactivated — existing subscriptions keep their terms.`)
      await reload()
    } catch (e: any) { setToast(e?.message) }
  }

  // custom plans (tenant-specific, never public) live in the Custom plans
  // section below — the catalog table and its KPIs stay the standard pricing
  // page. Subscriber counts still sum across ALL plans.
  const allPlans = data?.plans || []
  const catalogPlans = allPlans.filter((p) => !p.isCustom)

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-950/50">
              <PieChart className="h-4 w-4 text-white" />
            </span>
            Subscription Plans
          </span>
        }
        sub="Prices, capacity limits and module entitlements. Nothing is hardcoded anywhere — this table IS the pricing page."
        actions={
          section === "catalog" ? (
            <Button onClick={openNew} className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
              <Plus className="h-4 w-4" /> New plan
            </Button>
          ) : undefined
        }
      />

      {/* section toggle — the same tab-bar idiom as the Platform Settings page */}
      <div className="-mx-1 overflow-x-auto scroll-thin px-1 pb-1" role="tablist" aria-label="Plans sections">
        <div className="flex min-w-max gap-1.5">
          {(["catalog", "custom"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={section === k}
              type="button"
              onClick={() => setSection(k)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[12px] font-semibold transition-colors",
                section === k
                  ? "bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-indigo-950/40"
                  : "border border-white/10 light:border-slate-200 text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900",
              )}
            >
              {k === "catalog" ? <PieChart className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
              {k === "catalog" ? "Plan catalog" : "Custom plans"}
            </button>
          ))}
        </div>
      </div>

      {data && section === "catalog" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Plans" value={catalogPlans.length} icon={PieChart}
            sub={`${catalogPlans.filter((p) => p.active).length} active · ${catalogPlans.filter((p) => !p.active).length} deactivated`} />
          <KpiCard label="Public on /pricing" value={catalogPlans.filter((p) => p.isPublic).length} tone="indigo" icon={PieChart}
            sub={`${catalogPlans.filter((p) => !p.isPublic).length} hidden from the storefront`} />
          <KpiCard label="Trial plans" value={catalogPlans.filter((p) => p.isTrialPlan).length} icon={PieChart}
            sub="what registration approvals start tenants on" />
          <KpiCard label="Total subscribers" value={allPlans.reduce((s, p) => s + p.subscriberCount, 0).toLocaleString("en-IN")} tone="emerald" icon={PieChart}
            sub="every subscription row across all plans" />
        </div>
      )}
      {toast && (
        <p className="rounded-xl border border-blue-400/25 bg-blue-500/10 p-3 text-sm text-blue-200 light:text-blue-700">{toast}</p>
      )}
      {error && <ErrorBanner message={error} />}
      {section === "custom" ? (
        <CustomPlansSection catalog={allPlans} notify={setToast} />
      ) : loading ? <Loading /> : (
        <TableShell
          headers={["Plan", "Monthly", "Yearly", "Limits", "Modules", "Subscribers", "Storefront", "Status", ""]}
          empty={catalogPlans.length === 0}
        >
          {catalogPlans.map((p) => (
            <tr key={p.id} className="cursor-pointer transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60" onClick={() => openEdit(p)}>
              <Td>
                <span className="font-medium text-white light:text-slate-900">{p.name}</span>
                <span className="block max-w-56 truncate text-xs text-slate-500">{p.tagline || ""}{p.isTrialPlan ? " · trial plan" : ""}</span>
              </Td>
              <Td>৳{Number(p.monthlyPrice).toLocaleString()}</Td>
              <Td>৳{Number(p.yearlyPrice).toLocaleString()}</Td>
              <Td className="text-xs">
                {p.employeeLimit ? `${p.employeeLimit} emp` : "∞ emp"} · {p.storageGb != null ? (p.storageGb >= 1 ? `${p.storageGb} GB` : `${Math.round(p.storageGb * 1024)} MB`) : "∞ storage"} · {p.deviceLimit ? `${p.deviceLimit} dev` : "∞ dev"}
              </Td>
              <Td className="text-xs">
                {[p.payrollEnabled && "payroll", p.trackingEnabled && "tracking", p.inventoryEnabled && "inventory", p.essEnabled && "ESS", p.aitEnabled && "AIT"]
                  .filter(Boolean).join(", ") || "—"}
              </Td>
              <Td className="tabular-nums">{p.subscriberCount}</Td>
              <Td>{p.isPublic ? <StatusChip status="ACTIVE" /> : <span className="text-xs text-slate-500">hidden</span>}</Td>
              <Td>{p.active ? <StatusChip status="ACTIVE" /> : <StatusChip status="CANCELLED" />}</Td>
              <Td>
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => duplicate(p.id)} title="Duplicate" className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900"><Copy className="h-3.5 w-3.5" /></button>
                  <Switch checked={p.active} onCheckedChange={(v) => toggle(p, v)} />
                </div>
              </Td>
            </tr>
          ))}
        </TableShell>
      )}

      {/* editor */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white light:text-slate-900">
              <PieChart className="h-4 w-4 text-indigo-300 light:text-indigo-700" /> {form.id ? `Edit “${form.name}”` : "Create plan"}
            </DialogTitle>
          </DialogHeader>
          {formError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{formError}</p>}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label className="text-xs text-slate-400 light:text-slate-600">Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs text-slate-400 light:text-slate-600">Tagline (pricing card)</Label>
              <Input value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" placeholder="For growing organizations" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Monthly price (BDT)</Label>
              <Input type="number" min={0} value={form.monthlyPrice} onChange={(e) => setForm({ ...form, monthlyPrice: e.target.value })} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Yearly price (BDT)</Label>
              <Input type="number" min={0} value={form.yearlyPrice} onChange={(e) => setForm({ ...form, yearlyPrice: e.target.value })} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
          </div>

          <p className="mt-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Capacity limits (empty = unlimited)</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {([
              ["employeeLimit", "Employees"], ["userLimit", "Users"], ["branchLimit", "Branches"],
              ["departmentLimit", "Departments"], ["deviceLimit", "Devices"], ["storageGb", "Storage quota (GB — use 0.5 for 512 MB)"],
              ["trackingEmployeeLimit", "Tracking employees"],
            ] as const).map(([k, label]) => (
              <div key={k}>
                <Label className="text-xs text-slate-400 light:text-slate-600">{label}</Label>
                <Input type="number" min={1} value={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value } as any)}
                  placeholder="∞" className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
              </div>
            ))}
          </div>

          <p className="mt-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Module entitlements</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([
              ["payrollEnabled", "Payroll"], ["aitEnabled", "AIT"], ["inventoryEnabled", "Inventory"], ["procurementEnabled", "Procurement"],
              ["performanceEnabled", "Performance"], ["essEnabled", "Self-service"], ["cameraEnabled", "Cameras"], ["trackingEnabled", "Live tracking"],
              ["geofenceEnabled", "Geo-fence"], ["apiAccess", "API access"], ["advancedReports", "Adv. reports"], ["fieldForceEnabled", "Field force"],
            ] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setForm({ ...form, [k]: !(form as any)[k] } as any)}
                className={cn(
                  "rounded-lg border px-2 py-2 text-[11px] font-semibold",
                  (form as any)[k] ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 light:text-emerald-700" : "border-white/10 light:border-slate-200 text-slate-500"
                )}>
                {label}
              </button>
            ))}
          </div>

          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Support level</Label>
              <Select value={form.supportLevel} onValueChange={(v) => setForm({ ...form, supportLevel: v })}>
                <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
                <SelectContent>{["STANDARD", "PRIORITY", "DEDICATED"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Badge (pricing highlight)</Label>
              <Input value={form.badge} onChange={(e) => setForm({ ...form, badge: e.target.value })} placeholder="Most Popular" className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Sort order</Label>
              <Input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-xs text-slate-300 light:text-slate-700"><Switch checked={form.isPublic} onCheckedChange={(v) => setForm({ ...form, isPublic: v })} /> Listed on /pricing</label>
              <label className="flex items-center gap-2 text-xs text-slate-300 light:text-slate-700"><Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} /> Assignable</label>
              <label className="flex items-center gap-2 text-xs text-slate-300 light:text-slate-700"><Switch checked={form.isTrialPlan} onCheckedChange={(v) => setForm({ ...form, isTrialPlan: v })} /> Trial plan</label>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button onClick={save} disabled={busy || !form.name} className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Save className="h-4 w-4" /> {form.id ? "Save changes" : "Create plan"}</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== Custom Plan Builder (master prompt Part G §12) ====================
// A custom plan is a tenant-specific SaasPlan (isCustom + customForVendorId,
// isPublic=false → it never appears in any catalog or /pricing). The tenant
// picker rides owner.tenants.list (perm tenants.view — the SAME permission
// owner.plans.customList requires, so this section never demands a permission
// its own read doesn't; owner.supportAccess.tenants would need the unrelated
// support.access perm). Saves go through owner.plans.saveCustom (perm
// tenants.manage) with a REQUIRED audit reason.

type CustomPlanRow = {
  id: string
  name: string
  tagline: string | null
  description: string | null
  billingMode: "RECURRING" | "ONE_TIME"
  oneTimeValidityDays: number | null
  monthlyPrice: number
  yearlyPrice: number
  currency: string
  active: boolean
  limits: {
    employeeLimit: number | null; userLimit: number | null; branchLimit: number | null
    departmentLimit: number | null; deviceLimit: number | null; storageGb: number | null
    trackingEmployeeLimit: number | null
  }
  modules: {
    payrollEnabled: boolean; aitEnabled: boolean; inventoryEnabled: boolean; procurementEnabled: boolean
    performanceEnabled: boolean; essEnabled: boolean; cameraEnabled: boolean; trackingEnabled: boolean
    geofenceEnabled: boolean; apiAccess: boolean; advancedReports: boolean; fieldForceEnabled: boolean
  }
  supportLevel: string
  createdAt: string
}
type CustomListData = {
  vendor: { id: string; name: string }
  customPlans: CustomPlanRow[]
  basePlans: { id: string; name: string; tagline: string | null }[]
}

const CUSTOM_LIMIT_FIELDS = [
  ["employeeLimit", "Employees"], ["userLimit", "Users"], ["branchLimit", "Branches"],
  ["departmentLimit", "Departments"], ["deviceLimit", "Devices"], ["storageGb", "Storage quota (GB)"],
  ["trackingEmployeeLimit", "Tracking employees"],
] as const

const CUSTOM_MODULE_FIELDS = [
  ["payrollEnabled", "Payroll"], ["aitEnabled", "AIT"], ["inventoryEnabled", "Inventory"], ["procurementEnabled", "Procurement"],
  ["performanceEnabled", "Performance"], ["essEnabled", "Self-service"], ["cameraEnabled", "Cameras"], ["trackingEnabled", "Live tracking"],
  ["geofenceEnabled", "Geo-fence"], ["apiAccess", "API access"], ["advancedReports", "Adv. reports"], ["fieldForceEnabled", "Field force"],
] as const

const CUSTOM_BLANK = {
  planId: undefined as string | undefined, // set = editing that custom plan
  basePlanId: "",
  name: "", tagline: "", description: "",
  billingMode: "RECURRING" as "RECURRING" | "ONE_TIME",
  billingCycle: "MONTHLY" as "MONTHLY" | "YEARLY",
  monthlyPrice: "0", yearlyPrice: "0",
  // ONE_TIME validity is an EXPLICIT mandatory choice: fixed days or non-expiring
  oneTimeKind: "FIXED" as "FIXED" | "NEVER",
  oneTimeValidityDays: "365",
  employeeLimit: "", userLimit: "", branchLimit: "", departmentLimit: "", deviceLimit: "", storageGb: "", trackingEmployeeLimit: "",
  payrollEnabled: false, aitEnabled: false, inventoryEnabled: false, procurementEnabled: false,
  performanceEnabled: false, essEnabled: true, cameraEnabled: false, trackingEnabled: false,
  geofenceEnabled: false, apiAccess: false, advancedReports: false, fieldForceEnabled: false,
  supportLevel: "STANDARD",
  assignNow: false,
  reason: "",
}
type CustomForm = typeof CUSTOM_BLANK

function CustomPlansSection({ catalog, notify }: { catalog: Plan[]; notify: (msg: string) => void }) {
  const inputCls = "h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"

  // ---- tenant picker (owner.tenants.list — paged search) ----
  const [tenantSearch, setTenantSearch] = useState("")
  const [tenantRows, setTenantRows] = useState<{ id: string; name: string; code: string; active: boolean }[]>([])
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null)

  // ---- the tenant's custom plans + base catalog (owner.plans.customList) ----
  const [cl, setCl] = useState<CustomListData | null>(null)
  const [clLoading, setClLoading] = useState(false)
  const [clError, setClError] = useState<string | null>(null)

  // ---- builder dialog ----
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<CustomForm>({ ...CUSTOM_BLANK })
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // debounced tenant search — same idiom as the Support Access console
  useEffect(() => {
    if (vendor) return
    const t = setTimeout(async () => {
      try {
        const res = await ownerRpc<{ rows: { id: string; name: string; code: string; active: boolean }[] }>(
          "owner.tenants.list",
          { search: tenantSearch || undefined, page: 1, pageSize: 20 },
        )
        setTenantRows(res.rows || [])
      } catch { /* permission or transient — the picker just stays empty */ }
    }, 250)
    return () => clearTimeout(t)
  }, [tenantSearch, vendor])

  const loadCustom = useCallback(async (vid: string) => {
    setClLoading(true); setClError(null)
    try {
      setCl(await ownerRpc<CustomListData>("owner.plans.customList", { vendorId: vid }))
    } catch (e: any) {
      setClError(e?.message || "Could not load this tenant's custom plans.")
    } finally { setClLoading(false) }
  }, [])

  useEffect(() => {
    if (vendor) void loadCustom(vendor.id)
    else { setCl(null); setClError(null) }
  }, [vendor, loadCustom])

  const basePlans = catalog.filter((p) => p.active && p.isPublic && !p.isCustom)

  const applyBase = (basePlanId: string) => {
    const b = basePlanId ? catalog.find((p) => p.id === basePlanId) : undefined
    setForm((f) => ({
      ...f,
      basePlanId,
      tagline: b?.tagline || "",
      description: b?.description || "",
      monthlyPrice: b ? String(Number(b.monthlyPrice)) : "0",
      yearlyPrice: b ? String(Number(b.yearlyPrice)) : "0",
      employeeLimit: b?.employeeLimit?.toString() ?? "",
      userLimit: b?.userLimit?.toString() ?? "",
      branchLimit: b?.branchLimit?.toString() ?? "",
      departmentLimit: b?.departmentLimit?.toString() ?? "",
      deviceLimit: b?.deviceLimit?.toString() ?? "",
      storageGb: b?.storageGb?.toString() ?? "",
      trackingEmployeeLimit: b?.trackingEmployeeLimit?.toString() ?? "",
      payrollEnabled: b ? b.payrollEnabled : false,
      aitEnabled: b ? b.aitEnabled : false,
      inventoryEnabled: b ? b.inventoryEnabled : false,
      procurementEnabled: b ? b.procurementEnabled : false,
      performanceEnabled: b ? b.performanceEnabled : false,
      essEnabled: b ? b.essEnabled : true,
      cameraEnabled: b ? b.cameraEnabled : false,
      trackingEnabled: b ? b.trackingEnabled : false,
      geofenceEnabled: b ? b.geofenceEnabled : false,
      apiAccess: b ? b.apiAccess : false,
      advancedReports: b ? b.advancedReports : false,
      fieldForceEnabled: b ? (b.fieldForceEnabled ?? false) : false,
      supportLevel: b?.supportLevel || "STANDARD",
    }))
  }

  const openNew = () => { setForm({ ...CUSTOM_BLANK }); setFormError(null); setOpen(true) }

  const openEdit = (p: CustomPlanRow) => {
    setForm({
      planId: p.id,
      basePlanId: "", // ignored on edit — the plan already carries its values
      name: p.name, tagline: p.tagline || "", description: p.description || "",
      billingMode: p.billingMode,
      billingCycle: "MONTHLY",
      monthlyPrice: String(Number(p.monthlyPrice)), yearlyPrice: String(Number(p.yearlyPrice)),
      oneTimeKind: p.billingMode === "ONE_TIME" && p.oneTimeValidityDays == null ? "NEVER" : "FIXED",
      oneTimeValidityDays: p.oneTimeValidityDays != null ? String(p.oneTimeValidityDays) : "365",
      employeeLimit: p.limits.employeeLimit?.toString() ?? "",
      userLimit: p.limits.userLimit?.toString() ?? "",
      branchLimit: p.limits.branchLimit?.toString() ?? "",
      departmentLimit: p.limits.departmentLimit?.toString() ?? "",
      deviceLimit: p.limits.deviceLimit?.toString() ?? "",
      storageGb: p.limits.storageGb?.toString() ?? "",
      trackingEmployeeLimit: p.limits.trackingEmployeeLimit?.toString() ?? "",
      payrollEnabled: p.modules.payrollEnabled, aitEnabled: p.modules.aitEnabled,
      inventoryEnabled: p.modules.inventoryEnabled, procurementEnabled: p.modules.procurementEnabled,
      performanceEnabled: p.modules.performanceEnabled, essEnabled: p.modules.essEnabled,
      cameraEnabled: p.modules.cameraEnabled, trackingEnabled: p.modules.trackingEnabled,
      geofenceEnabled: p.modules.geofenceEnabled, apiAccess: p.modules.apiAccess,
      advancedReports: p.modules.advancedReports, fieldForceEnabled: p.modules.fieldForceEnabled,
      supportLevel: p.supportLevel,
      assignNow: false,
      reason: "",
    })
    setFormError(null)
    setOpen(true)
  }

  const saveCustom = async () => {
    if (!vendor) return
    setFormError(null)
    const name = form.name.trim()
    const reason = form.reason.trim()
    const price = Number(form.monthlyPrice)
    const yearly = Number(form.yearlyPrice)
    const days = Number(form.oneTimeValidityDays)
    if (name.length < 2 || name.length > 80) { setFormError("Name must be 2–80 characters."); return }
    if (!Number.isFinite(price) || price < 0 || price > 10_000_000) { setFormError("Price must be between 0 and 10,000,000."); return }
    if (form.billingMode === "RECURRING" && (!Number.isFinite(yearly) || yearly < 0 || yearly > 10_000_000)) {
      setFormError("Yearly price must be between 0 and 10,000,000."); return
    }
    if (form.billingMode === "ONE_TIME" && form.oneTimeKind === "FIXED" && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      setFormError("Validity must be a whole number of days between 1 and 3650 — or choose “Non-expiring”."); return
    }
    for (const [k] of CUSTOM_LIMIT_FIELDS) {
      const v = (form as any)[k] as string
      if (v !== "" && (!/^\d+$/.test(v.trim()) || Number(v) < 1)) {
        setFormError("Limits must be whole numbers ≥ 1 (leave empty for unlimited)."); return
      }
    }
    if (reason.length < 5) { setFormError("An audit reason of at least 5 characters is required."); return }

    setBusy(true)
    try {
      const num = (v: string) => (v.trim() === "" ? null : Number(v))
      // owner.plans.saveCustom is .strict() — only schema keys, and the
      // string fields are optional (NOT nullable): omit tagline/description
      // when empty instead of sending null.
      const payload: Record<string, unknown> = {
        vendorId: vendor.id,
        name,
        billingMode: form.billingMode,
        billingCycle: form.billingCycle,
        monthlyPrice: price,
        currency: "BDT",
        employeeLimit: num(form.employeeLimit),
        userLimit: num(form.userLimit),
        branchLimit: num(form.branchLimit),
        departmentLimit: num(form.departmentLimit),
        deviceLimit: num(form.deviceLimit),
        storageGb: num(form.storageGb),
        trackingEmployeeLimit: num(form.trackingEmployeeLimit),
        payrollEnabled: form.payrollEnabled, aitEnabled: form.aitEnabled,
        inventoryEnabled: form.inventoryEnabled, procurementEnabled: form.procurementEnabled,
        performanceEnabled: form.performanceEnabled, essEnabled: form.essEnabled,
        cameraEnabled: form.cameraEnabled, trackingEnabled: form.trackingEnabled,
        geofenceEnabled: form.geofenceEnabled, apiAccess: form.apiAccess,
        advancedReports: form.advancedReports, fieldForceEnabled: form.fieldForceEnabled,
        supportLevel: form.supportLevel,
        assignNow: form.assignNow,
        reason,
      }
      if (form.tagline.trim()) payload.tagline = form.tagline.trim()
      if (form.description.trim()) payload.description = form.description.trim()
      if (form.planId) payload.planId = form.planId
      if (!form.planId && form.basePlanId) payload.basePlanId = form.basePlanId
      if (form.billingMode === "RECURRING") {
        payload.yearlyPrice = yearly
        payload.oneTimeValidityDays = null
      } else {
        // ONE_TIME: null is the EXPLICIT "non-expiring" choice
        payload.oneTimeValidityDays = form.oneTimeKind === "FIXED" ? days : null
      }
      const res = await ownerRpc<{ planId: string; name: string; assigned: boolean }>("owner.plans.saveCustom", payload)
      setOpen(false)
      notify(res.assigned
        ? `Custom plan “${res.name}” saved and assigned to ${vendor.name}.`
        : `Custom plan “${res.name}” saved for ${vendor.name}${form.assignNow ? "" : " — assign it from the tenant's subscription when ready"}.`)
      await loadCustom(vendor.id)
    } catch (e: any) {
      setFormError(e?.message || "Save failed.")
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      {/* ---- tenant picker ---- */}
      <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-slate-400" />
            <p className="text-sm font-bold text-white light:text-slate-900">Custom plans by tenant</p>
          </div>
          {vendor && (
            <Button size="sm" onClick={openNew} disabled={!cl}
              className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
              <Plus className="h-4 w-4" /> New custom plan
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          A custom plan is bound to ONE tenant and never appears in public catalogs, /pricing or self-service flows.
          Historical invoices and payments are never rewritten — assignments snapshot on the subscription.
        </p>
        <div className="mt-4">
          <Label className="text-xs text-slate-400 light:text-slate-600">Tenant</Label>
          {vendor ? (
            <div className="mt-1.5 flex items-center justify-between rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2">
              <span className="text-sm text-emerald-200 light:text-emerald-700">{vendor.name}</span>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setVendor(null); setTenantSearch(""); setTenantRows([]) }}>change</Button>
            </div>
          ) : (
            <div className="relative mt-1.5">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
              <Input value={tenantSearch} onChange={(e) => setTenantSearch(e.target.value)} className={`${inputCls} pl-9`} placeholder="Search tenants by name or code…" />
              {tenantRows.length > 0 && (
                <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-white/10 bg-slate-900/95 light:bg-white p-1 shadow-xl">
                  {tenantRows.map((t) => (
                    <button key={t.id} type="button" className="block w-full rounded-md px-3 py-2 text-left text-xs text-slate-200 light:text-slate-800 hover:bg-white/10 light:hover:bg-slate-100"
                      onClick={() => { setVendor({ id: t.id, name: t.name }); setTenantRows([]); setTenantSearch("") }}>
                      {t.name} <span className="text-slate-500">({t.code}{t.active ? "" : " · inactive"})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---- the tenant's custom plans ---- */}
      {vendor && (
        clLoading ? <Loading /> : clError ? (
          <ErrorBanner message={clError} />
        ) : (
          <TableShell
            headers={["Plan", "Billing", "Price", "Support", "Status", "Created", ""]}
            empty={(cl?.customPlans.length ?? 0) === 0}
          >
            {cl?.customPlans.map((p) => (
              <tr key={p.id} className="cursor-pointer transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60" onClick={() => openEdit(p)}>
                <Td>
                  <span className="font-medium text-white light:text-slate-900">{p.name}</span>
                  <span className="block max-w-56 truncate text-xs text-slate-500">{p.tagline || ""}</span>
                </Td>
                <Td>
                  {p.billingMode === "ONE_TIME" ? (
                    <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300 light:text-amber-700">
                      One-time · {p.oneTimeValidityDays != null ? `${p.oneTimeValidityDays} days` : "Non-expiring"}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-violet-400/40 bg-violet-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-violet-300 light:text-violet-700">
                      Recurring
                    </span>
                  )}
                </Td>
                <Td className="tabular-nums">
                  ৳{Number(p.monthlyPrice).toLocaleString()}{p.billingMode === "ONE_TIME" ? " once" : " /mo"}
                </Td>
                <Td className="text-xs">{p.supportLevel}</Td>
                <Td>{p.active ? <StatusChip status="ACTIVE" /> : <StatusChip status="CANCELLED" />}</Td>
                <Td className="text-xs">{new Date(p.createdAt).toLocaleDateString()}</Td>
                <Td>
                  <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="outline" onClick={() => openEdit(p)}
                      className="h-7 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs text-white light:text-slate-900">
                      Edit
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </TableShell>
        )
      )}
      {vendor && (cl?.customPlans.length ?? 0) === 0 && !clLoading && (
        <p className="text-[11px] leading-relaxed text-slate-500">
          No custom plans for this tenant yet — “New custom plan” builds one from scratch or from a base plan&apos;s defaults.
        </p>
      )}

      {/* ---- builder dialog ---- */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white light:text-slate-900">
              <Users className="h-4 w-4 text-indigo-300 light:text-indigo-700" />
              {form.planId ? `Edit “${form.name}”` : `New custom plan${vendor ? ` — ${vendor.name}` : ""}`}
            </DialogTitle>
          </DialogHeader>
          {formError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{formError}</p>}

          <div className="grid gap-4 sm:grid-cols-2">
            {!form.planId && (
              <div className="sm:col-span-2">
                <Label className="text-xs text-slate-400 light:text-slate-600">Start from a base plan (loads its defaults)</Label>
                <Select value={form.basePlanId || "none"} onValueChange={applyBase}>
                  <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Start from scratch</SelectItem>
                    {basePlans.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="sm:col-span-2">
              <Label className="text-xs text-slate-400 light:text-slate-600">Name (2–80 characters)</Label>
              <Input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`mt-1.5 ${inputCls}`} placeholder="e.g. Galaxy Textiles — Annual Enterprise" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Tagline</Label>
              <Input value={form.tagline} maxLength={160} onChange={(e) => setForm({ ...form, tagline: e.target.value })} className={`mt-1.5 ${inputCls}`} placeholder="Negotiated enterprise package" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Support level</Label>
              <Select value={form.supportLevel} onValueChange={(v) => setForm({ ...form, supportLevel: v })}>
                <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
                <SelectContent>{["STANDARD", "PRIORITY", "DEDICATED"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs text-slate-400 light:text-slate-600">Description</Label>
              <Textarea value={form.description} maxLength={1000} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2}
                className="mt-1.5 min-h-16 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-sm text-white light:text-slate-900" />
            </div>

            {/* billing mode */}
            <div className="sm:col-span-2">
              <Label className="text-xs text-slate-400 light:text-slate-600">Billing mode</Label>
              <div className="mt-1.5 flex gap-2">
                {(["RECURRING", "ONE_TIME"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setForm({ ...form, billingMode: m })}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs font-semibold",
                      form.billingMode === m
                        ? "border-indigo-400/50 bg-indigo-600/20 text-white light:border-indigo-400 light:bg-indigo-50 light:text-indigo-700"
                        : "border-white/10 light:border-slate-200 text-slate-500 light:text-slate-500",
                    )}>
                    {m === "RECURRING" ? "Recurring" : "One-time"}
                  </button>
                ))}
              </div>
            </div>
            {form.billingMode === "RECURRING" ? (
              <>
                <div>
                  <Label className="text-xs text-slate-400 light:text-slate-600">Monthly price (BDT)</Label>
                  <Input type="number" min={0} max={10_000_000} value={form.monthlyPrice} onChange={(e) => setForm({ ...form, monthlyPrice: e.target.value })} className={`mt-1.5 ${inputCls}`} />
                </div>
                <div>
                  <Label className="text-xs text-slate-400 light:text-slate-600">Yearly price (BDT)</Label>
                  <Input type="number" min={0} max={10_000_000} value={form.yearlyPrice} onChange={(e) => setForm({ ...form, yearlyPrice: e.target.value })} className={`mt-1.5 ${inputCls}`} />
                </div>
                <div>
                  <Label className="text-xs text-slate-400 light:text-slate-600">Default billing cycle</Label>
                  <Select value={form.billingCycle} onValueChange={(v) => setForm({ ...form, billingCycle: v as "MONTHLY" | "YEARLY" })}>
                    <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="MONTHLY">Monthly</SelectItem><SelectItem value="YEARLY">Yearly</SelectItem></SelectContent>
                  </Select>
                </div>
              </>
            ) : (
              <>
                <div>
                  <Label className="text-xs text-slate-400 light:text-slate-600">One-time charge (BDT)</Label>
                  <Input type="number" min={0} max={10_000_000} value={form.monthlyPrice} onChange={(e) => setForm({ ...form, monthlyPrice: e.target.value })} className={`mt-1.5 ${inputCls}`} />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-slate-400 light:text-slate-600">Validity — pick one explicitly</Label>
                  <div className="mt-1.5 space-y-2">
                    <label className={cn(
                      "flex items-center gap-2.5 rounded-lg border p-3",
                      form.oneTimeKind === "FIXED" ? "border-indigo-400/50 bg-indigo-600/10" : "border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50",
                    )}>
                      <input type="radio" name="oneTimeKind" checked={form.oneTimeKind === "FIXED"} onChange={() => setForm({ ...form, oneTimeKind: "FIXED" })} className="accent-indigo-500" />
                      <span className="text-xs text-slate-300 light:text-slate-700">Fixed validity</span>
                      <Input type="number" min={1} max={3650} value={form.oneTimeValidityDays} disabled={form.oneTimeKind !== "FIXED"}
                        onChange={(e) => setForm({ ...form, oneTimeValidityDays: e.target.value })}
                        className={`ml-auto w-28 ${inputCls} disabled:opacity-50`} />
                      <span className="text-xs text-slate-500">days</span>
                    </label>
                    <label className={cn(
                      "flex items-center gap-2.5 rounded-lg border p-3",
                      form.oneTimeKind === "NEVER" ? "border-indigo-400/50 bg-indigo-600/10" : "border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50",
                    )}>
                      <input type="radio" name="oneTimeKind" checked={form.oneTimeKind === "NEVER"} onChange={() => setForm({ ...form, oneTimeKind: "NEVER" })} className="accent-indigo-500" />
                      <span className="text-xs text-slate-300 light:text-slate-700">Non-expiring — the subscription never ends on its own</span>
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>

          <p className="mt-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Capacity limits (empty = unlimited)</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {CUSTOM_LIMIT_FIELDS.map(([k, label]) => (
              <div key={k}>
                <Label className="text-xs text-slate-400 light:text-slate-600">{label}</Label>
                <Input type="number" min={1} value={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value } as any)}
                  placeholder="∞" className={`mt-1.5 ${inputCls}`} />
              </div>
            ))}
          </div>

          <p className="mt-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Module entitlements</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CUSTOM_MODULE_FIELDS.map(([k, label]) => (
              <button key={k} type="button" onClick={() => setForm({ ...form, [k]: !(form as any)[k] } as any)}
                className={cn(
                  "rounded-lg border px-2 py-2 text-[11px] font-semibold",
                  (form as any)[k] ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 light:text-emerald-700" : "border-white/10 light:border-slate-200 text-slate-500",
                )}>
                {label}
              </button>
            ))}
          </div>

          <label className="mt-3 flex items-center gap-2 rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3 text-xs text-slate-300 light:text-slate-700">
            <Switch checked={form.assignNow} onCheckedChange={(v) => setForm({ ...form, assignNow: v })} />
            Assign to {vendor ? vendor.name : "tenant"} immediately (runs the real change-plan flow — events, snapshots, audit)
          </label>

          <div>
            <Label className="text-xs text-slate-400 light:text-slate-600">Reason (required — 5–500 characters, recorded in the audit log)</Label>
            <Textarea value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={2}
              className="mt-1.5 min-h-16 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-sm text-white light:text-slate-900"
              placeholder="e.g. Annual deal negotiated over ticket #4821 — ৳1,20,000 one-time for 12 months" />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button onClick={saveCustom} disabled={busy || form.name.trim().length < 2} className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Save className="h-4 w-4" /> {form.planId ? "Save changes" : "Create custom plan"}</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

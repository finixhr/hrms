"use client"
// ============ Companies — multi-company management (2026-11-03) ============
// The tenant's operating companies: directory, creation wizard, profile
// editing, default selection, activation control and per-user company access
// assignment (UserCompanyAccess).
//
// Security posture (mirrors the server):
//  · companies.* routes require the tenant-level companies permission family;
//    a company administrator can manage nothing here without it.
//  · the ACTIVE company context (workspace switcher) is shown on the surface
//    so the operator always knows which company's settings they touch.
//  · company deactivation NEVER deletes history — it only blocks new business.
import { useMemo, useState } from "react"
import { Building2, Plus, Pencil, Star, ShieldCheck, Users, Power, StarOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { PageHeader, StatCard, SectionTabs, EmptyState } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"

export default function CompaniesView() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Companies"
        subtitle="Independent operating units of your workspace — each with its own branches, employees, payroll and accounting books"
      />
      <SectionTabs
        defaultValue={(useHrm((st) => (st.view?.key === "companies" && (st.view?.params as any)?.tab)) as string) || "directory"}
        tabs={[
          { value: "directory", label: "Company Directory", content: <DirectoryTab /> },
          { value: "access", label: "User Access", content: <AccessTab /> },
        ]}
      />
    </div>
  )
}

// ---------------------------------------------------------------- directory
function DirectoryTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const activeCompanyId = useHrm((s) => s.activeCompanyId)
  const { data, loading, error, reload } = useApi<any[]>("companies.list", {})
  const { data: capacity, reload: reloadCapacity } = useApi<{ used: number; limit: number | null; planName: string | null }>("companies.capacity", {})
  const atLimit = capacity?.limit != null && capacity.used >= capacity.limit
  const reloadAll = () => { reload(); reloadCapacity() }
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [confirmAction, setConfirmAction] = useState<{ rec: any; kind: "deactivate" | "activate" | "default" } | null>(null)

  const rows = useMemo(() => data || [], [data])
  const totals = useMemo(() => ({
    companies: rows.length,
    active: rows.filter((r) => r.active).length,
    branches: rows.reduce((s, r) => s + (r.branchCount || 0), 0),
    employees: rows.reduce((s, r) => s + (r.employeeCount || 0), 0),
  }), [rows])

  const columns: Column<any>[] = [
    {
      key: "name", label: "Company", render: (r) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-8 w-8 rounded-md bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center shrink-0">
            <Building2 className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate flex items-center gap-1.5">
              {r.name}
              {r.isDefault && <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300 text-[9px] px-1" >DEFAULT</Badge>}
              {r.id === activeCompanyId && <Badge variant="outline" className="text-[9px] px-1 border-emerald-400 text-emerald-600 dark:text-emerald-300">ACTIVE CONTEXT</Badge>}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">{r.code}{r.legalName && r.legalName !== r.name ? ` · ${r.legalName}` : ""}</div>
          </div>
        </div>
      ),
    },
    { key: "branchCount", label: "Branches", render: (r) => <span className="text-sm tabular-nums">{r.branchCount ?? 0}</span> },
    { key: "employeeCount", label: "Employees", render: (r) => <span className="text-sm tabular-nums">{r.employeeCount ?? 0}</span> },
    { key: "currency", label: "Currency / FY", render: (r) => <span className="text-xs text-muted-foreground">{r.currency} · FY {r.fiscalYearStart}</span> },
    {
      key: "active", label: "Status", render: (r) => (
        <StatusBadge state={r.active} />
      ),
    },
    {
      key: "_actions", label: "", render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {can("companies", "edit") && (
            <>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditRec(r)} title="Edit company profile">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              {!r.isDefault && r.active && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setConfirmAction({ rec: r, kind: "default" })} title="Set as default company">
                  <Star className="h-3.5 w-3.5" />
                </Button>
              )}
              {!r.isDefault && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setConfirmAction({ rec: r, kind: r.active ? "deactivate" : "activate" })} title={r.active ? "Deactivate company" : "Reactivate company"}>
                  <Power className={`h-3.5 w-3.5 ${r.active ? "text-rose-500" : "text-emerald-500"}`} />
                </Button>
              )}
            </>
          )}
        </div>
      ),
    },
  ]

  const runAction = async () => {
    if (!confirmAction) return
    const { rec, kind } = confirmAction
    try {
      if (kind === "default") {
        await rpc("companies.setDefault", { id: rec.id })
        toast(`${rec.name} is now the default company`, "ok")
      } else {
        await rpc("companies.deactivate", { id: rec.id, active: kind === "activate" })
        toast(kind === "activate" ? `${rec.name} reactivated` : `${rec.name} deactivated — historical records are preserved`, "ok")
      }
      reloadAll()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setConfirmAction(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Companies" value={totals.companies} icon={Building2} tone="emerald" />
        <StatCard label="Active" value={totals.active} icon={Power} tone="sky" />
        <StatCard label="Branches" value={totals.branches} icon={Building2} tone="violet" />
        <StatCard label="Employees" value={totals.employees} icon={Users} tone="amber" />
      </div>

      {capacity?.limit != null && (
        <p className={`text-xs ${atLimit ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
          {capacity.used} of {capacity.limit} active {capacity.limit === 1 ? "company" : "companies"} used on your {capacity.planName || "current"} plan.
          {atLimit ? " Upgrade your plan to add another, or deactivate one you no longer use." : ""}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        searchable
        csvName="companies"
        emptyTitle="No companies yet"
        emptyHint="Every workspace starts with one default company. Create another to manage a group of companies under the same subscription."
        toolbar={can("companies", "create") ? (
          <Button size="sm" className="gap-1.5" disabled={atLimit} title={atLimit ? "Your plan's company limit is reached" : undefined} onClick={() => setWizardOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New Company
          </Button>
        ) : undefined}
      />

      <CompanyWizard open={wizardOpen} onOpenChange={setWizardOpen} onCreated={() => { setWizardOpen(false); reloadAll() }} />
      <EditCompanyDialog rec={editRec} onOpenChange={(v) => !v && setEditRec(null)} onSaved={() => { setEditRec(null); reload() }} />

      <ConfirmDialog
        open={!!confirmAction}
        onOpenChange={(v) => !v && setConfirmAction(null)}
        title={confirmAction?.kind === "default" ? "Set default company" : confirmAction?.kind === "deactivate" ? "Deactivate company" : "Reactivate company"}
        message={
          confirmAction?.kind === "default"
            ? `Make "${confirmAction?.rec?.name}" the default company? New users and unscoped flows will default to it.`
            : confirmAction?.kind === "deactivate"
              ? `Deactivate "${confirmAction?.rec?.name}"? No data is deleted — historical records, payroll and journals stay intact — but the company is excluded from new business and users lose access to it.`
              : `Reactivate "${confirmAction?.rec?.name}"? Users with access will be able to work in it again.`
        }
        confirmLabel={confirmAction?.kind === "deactivate" ? "Deactivate" : "Confirm"}
        danger={confirmAction?.kind === "deactivate"}
        onConfirm={runAction}
      />
    </div>
  )
}

function StatusBadge({ state }: { state: boolean }) {
  return state
    ? <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300 hover:bg-emerald-100">Active</Badge>
    : <Badge variant="secondary" className="opacity-80">Inactive</Badge>
}

// ---------------------------------------------------------------- wizard
const WIZARD_STEPS = [
  { title: "Basic Information", hint: "Identity and contact details of the new company" },
  { title: "Business Information", hint: "Registration, tax and regional settings" },
  { title: "Initial Configuration", hint: "Where the company's HR policy baseline comes from" },
  { title: "Administrator Access", hint: "Who can operate this company" },
  { title: "Review & Create", hint: "Confirm and create the company" },
]

function CompanyWizard({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const toast = useHrm((s) => s.toast)
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [values, setValues] = useState<Record<string, any>>({ initMode: "copyTenant", administrators: [] as any[] })
  const [users, setUsers] = useState<any[]>([])

  // load the tenant's users for the administrator step
  useMemo(() => {
    if (open && users.length === 0) {
      rpc("users.list", {}).then((d: any) => setUsers(Array.isArray(d) ? d : d?.users || [])).catch(() => {})
    }
  }, [open, users.length])

  const set = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }))

  const stepValid = (i: number): boolean => {
    if (i === 0) return !!values.name && String(values.name).trim().length >= 2
    if (i === 1) return true
    if (i === 2) return !!values.initMode
    if (i === 3) return true
    return true
  }

  const submit = async () => {
    setBusy(true)
    try {
      await rpc("companies.create", {
        name: values.name,
        code: values.code || undefined,
        legalName: values.legalName || undefined,
        shortName: values.shortName || undefined,
        registrationNumber: values.registrationNumber || undefined,
        taxIdentificationNumber: values.taxIdentificationNumber || undefined,
        binVatReg: values.binVatReg || undefined,
        email: values.email || undefined,
        phone: values.phone || undefined,
        alternatePhone: values.alternatePhone || undefined,
        address: values.address || undefined,
        city: values.city || undefined,
        district: values.district || undefined,
        country: values.country || undefined,
        currency: values.currency || undefined,
        timezone: values.timezone || undefined,
        dateFormat: values.dateFormat || undefined,
        fiscalYearStart: values.fiscalYearStart || undefined,
        website: values.website || undefined,
        logoUrl: values.logoUrl || undefined,
        initMode: values.initMode || "copyTenant",
        administrators: (values.administrators || []).filter((a: any) => a.userId && a.role),
      })
      toast(`Company "${values.name}" created`, "ok")
      setValues({ initMode: "copyTenant", administrators: [] })
      setStep(0)
      onCreated()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  const input = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
  const label = "text-xs font-medium text-foreground/80"

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" role="dialog" aria-modal="true" aria-label="Create company">
      <div className="bg-background border rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-md bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center">
              <Building2 className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">New Company</h2>
              <p className="text-[11px] text-muted-foreground">{WIZARD_STEPS[step].hint}</p>
            </div>
          </div>
          {/* step indicator */}
          <div className="mt-3 flex items-center gap-1">
            {WIZARD_STEPS.map((s, i) => (
              <div key={s.title} className="flex-1">
                <div className={`h-1 rounded-full ${i <= step ? "bg-emerald-500" : "bg-muted"}`} />
                <div className={`mt-1 text-[9px] ${i === step ? "text-foreground font-semibold" : "text-muted-foreground"} hidden sm:block`}>
                  {i + 1}. {s.title}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-3 flex-1">
          {step === 0 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2 space-y-1">
                  <label className={label}>Company name *</label>
                  <input className={input} value={values.name || ""} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Rongin Fashion Ltd." />
                </div>
                <div className="space-y-1">
                  <label className={label}>Code</label>
                  <input className={input} value={values.code || ""} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="e.g. RFL" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className={label}>Legal name</label>
                  <input className={input} value={values.legalName || ""} onChange={(e) => set("legalName", e.target.value)} placeholder="Registered legal name" />
                </div>
                <div className="space-y-1">
                  <label className={label}>Short name</label>
                  <input className={input} value={values.shortName || ""} onChange={(e) => set("shortName", e.target.value)} placeholder="e.g. Rongin" />
                </div>
                <div className="space-y-1">
                  <label className={label}>Email</label>
                  <input className={input} type="email" value={values.email || ""} onChange={(e) => set("email", e.target.value)} placeholder="info@company.com" />
                </div>
                <div className="space-y-1">
                  <label className={label}>Phone</label>
                  <input className={input} value={values.phone || ""} onChange={(e) => set("phone", e.target.value)} placeholder="+880 …" />
                </div>
              </div>
              <div className="space-y-1">
                <label className={label}>Address</label>
                <input className={input} value={values.address || ""} onChange={(e) => set("address", e.target.value)} placeholder="Head office address" />
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className={label}>Registration number</label>
                  <input className={input} value={values.registrationNumber || ""} onChange={(e) => set("registrationNumber", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={label}>Tax identification (TIN)</label>
                  <input className={input} value={values.taxIdentificationNumber || ""} onChange={(e) => set("taxIdentificationNumber", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={label}>BIN / VAT registration</label>
                  <input className={input} value={values.binVatReg || ""} onChange={(e) => set("binVatReg", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={label}>Website</label>
                  <input className={input} value={values.website || ""} onChange={(e) => set("website", e.target.value)} placeholder="https://…" />
                </div>
                <div className="space-y-1">
                  <label className={label}>Currency</label>
                  <select className={input} value={values.currency || "BDT"} onChange={(e) => set("currency", e.target.value)}>
                    {["BDT", "USD", "EUR", "GBP", "INR", "AED", "SAR", "MYR", "SGD"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className={label}>Timezone</label>
                  <select className={input} value={values.timezone || "Asia/Dhaka"} onChange={(e) => set("timezone", e.target.value)}>
                    {["Asia/Dhaka", "Asia/Kolkata", "Asia/Karachi", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className={label}>Fiscal year starts</label>
                  <select className={input} value={values.fiscalYearStart || "July"} onChange={(e) => set("fiscalYearStart", e.target.value)}>
                    {["January", "April", "July", "October"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className={label}>Date format</label>
                  <select className={input} value={values.dateFormat || "DD/MM/YYYY"} onChange={(e) => set("dateFormat", e.target.value)}>
                    {["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD MMM YYYY"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className={label}>City</label>
                  <input className={input} value={values.city || ""} onChange={(e) => set("city", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className={label}>District</label>
                  <input className={input} value={values.district || ""} onChange={(e) => set("district", e.target.value)} />
                </div>
              </div>
            </>
          )}
          {step === 2 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                The new company&apos;s HR policy baseline (attendance, leave, payroll, tax, shift and accounting settings):
              </p>
              {[
                { value: "copyTenant", title: "Copy from workspace defaults", hint: "Start from this tenant's current policy settings — the usual choice for a group company operating under the same rules." },
                { value: "systemDefaults", title: "Start with system defaults", hint: "Configure every policy from scratch in the company's own Settings." },
              ].map((opt) => (
                <label
                  key={opt.value}
                  className={`flex gap-3 items-start rounded-lg border p-3 cursor-pointer transition-colors ${values.initMode === opt.value ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : "hover:bg-accent"}`}
                >
                  <input type="radio" className="mt-0.5" checked={values.initMode === opt.value} onChange={() => set("initMode", opt.value)} />
                  <div>
                    <div className="text-sm font-medium">{opt.title}</div>
                    <div className="text-[11px] text-muted-foreground">{opt.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
          {step === 3 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Grant workspace users access to the new company. Every user keeps their own role per company.
              </p>
              {(values.administrators || []).map((admin: any, i: number) => (
                <div key={i} className="flex gap-2 items-center">
                  <select
                    className={input}
                    value={admin.userId || ""}
                    onChange={(e) => set("administrators", (values.administrators || []).map((a: any, j: number) => j === i ? { ...a, userId: e.target.value } : a))}
                  >
                    <option value="">Select user…</option>
                    {users.filter((u) => u.role !== "EMPLOYEE").map((u) => (
                      <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                    ))}
                  </select>
                  <select
                    className={`${input} max-w-[180px]`}
                    value={admin.role || "HR_ADMIN"}
                    onChange={(e) => set("administrators", (values.administrators || []).map((a: any, j: number) => j === i ? { ...a, role: e.target.value } : a))}
                  >
                    {["VENDOR_OWNER", "HR_ADMIN", "HR_MANAGER", "PAYROLL_OFFICER", "BRANCH_MANAGER", "DEPT_MANAGER"].map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                  </select>
                  <Button variant="ghost" size="sm" className="h-9 px-2 text-rose-500" onClick={() => set("administrators", (values.administrators || []).filter((_: any, j: number) => j !== i))}>Remove</Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => set("administrators", [...(values.administrators || []), { userId: "", role: "HR_ADMIN" }])}>
                <Plus className="h-3.5 w-3.5" /> Add administrator
              </Button>
            </div>
          )}
          {step === 4 && (
            <div className="space-y-2 text-sm">
              <div className="rounded-lg border p-3 space-y-1.5">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Review</div>
                {[
                  ["Name", values.name],
                  ["Code", values.code || "(auto)"],
                  ["Legal name", values.legalName || "—"],
                  ["Currency / FY", `${values.currency || "BDT"} · starts ${values.fiscalYearStart || "July"}`],
                  ["Timezone", values.timezone || "Asia/Dhaka"],
                  ["Configuration", values.initMode === "copyTenant" ? "Copy workspace defaults" : "System defaults"],
                  ["Administrators", (values.administrators || []).filter((a: any) => a.userId).length ? (values.administrators || []).filter((a: any) => a.userId).map((a: any) => `${users.find((u) => u.id === a.userId)?.name || a.userId} (${a.role.replace(/_/g, " ")})`).join(", ") : "None yet (assign later in User Access)"],
                ].map(([k, v]) => (
                  <div key={k as string} className="flex justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">{k}</span>
                    <span className="font-medium text-right">{String(v || "—")}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Creating the company is transactional: profile, initial settings and administrator access land together.
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => { onOpenChange(false); setStep(0) }}>Cancel</Button>
          <div className="flex gap-2">
            {step > 0 && <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>Back</Button>}
            {step < WIZARD_STEPS.length - 1 ? (
              <Button size="sm" disabled={!stepValid(step)} onClick={() => setStep((s) => s + 1)}>Continue</Button>
            ) : (
              <Button size="sm" disabled={busy || !stepValid(0)} onClick={submit}>{busy ? "Creating…" : "Create Company"}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- edit
function EditCompanyDialog({ rec, onOpenChange, onSaved }: { rec: any; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  if (!rec) return null
  const fields: FieldDef[] = [
    { name: "name", label: "Company name", required: true },
    { name: "code", label: "Code", help: "Letters, digits, - and _ only" },
    { name: "legalName", label: "Legal name" },
    { name: "shortName", label: "Short name" },
    { name: "registrationNumber", label: "Registration number" },
    { name: "taxIdentificationNumber", label: "Tax ID (TIN)" },
    { name: "binVatReg", label: "BIN / VAT registration" },
    { name: "website", label: "Website" },
    { name: "email", label: "Email", type: "email" },
    { name: "phone", label: "Phone" },
    { name: "alternatePhone", label: "Alternate phone" },
    { name: "address", label: "Address", span: 2 },
    { name: "city", label: "City" },
    { name: "district", label: "District" },
    { name: "country", label: "Country" },
    { name: "currency", label: "Currency" },
    { name: "timezone", label: "Timezone" },
    { name: "fiscalYearStart", label: "Fiscal year starts" },
    { name: "dateFormat", label: "Date format" },
    { name: "signatoryName", label: "Authorized signatory" },
    { name: "signatoryDesignation", label: "Signatory designation" },
  ]
  return (
    <FormDialog
      open={!!rec}
      onOpenChange={onOpenChange}
      title={`Edit ${rec.name}`}
      description="The company profile is used on payslips, letters and reports of this company."
      fields={fields}
      initial={rec}
      wide
      onSubmit={async (v) => {
        const clean: Record<string, any> = {}
        for (const [k, val] of Object.entries(v)) {
          if (val !== "" && val != null) clean[k] = val
        }
        await rpc("companies.update", { id: rec.id, ...clean })
        onSaved()
      }}
    />
  )
}

// ---------------------------------------------------------------- access
function AccessTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const activeCompanyId = useHrm((s) => s.activeCompanyId)
  const { data: companies } = useApi<any[]>("companies.options", {})
  const [companyId, setCompanyId] = useState<string>("")
  const selected = companyId || activeCompanyId || companies?.[0]?.id || ""
  const { data, loading, error, reload } = useApi<any[]>(
    selected ? "companies.access.list" : null,
    { companyId: selected },
  )
  const { data: users } = useApi<any[]>("users.list", {})
  const [assignOpen, setAssignOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<any>(null)

  const columns: Column<any>[] = [
    {
      key: "user", label: "User", render: (r) => (
        <div>
          <div className="text-sm font-medium">{r.user?.name}</div>
          <div className="text-[11px] text-muted-foreground">{r.user?.email}</div>
        </div>
      ),
    },
    {
      key: "role", label: "Role in company", render: (r) => (
        <Badge variant="outline" className="text-[10px]">{String(r.role || "").replace(/_/g, " ")}</Badge>
      ),
    },
    {
      key: "scope", label: "Org scope", render: (r) => {
        const b = (() => { try { return JSON.parse(r.branchScope || "null") } catch { return null } })()
        const d = (() => { try { return JSON.parse(r.departmentScope || "null") } catch { return null } })()
        return (
          <span className="text-xs text-muted-foreground">
            {b?.length ? `${b.length} branch(es)` : "All branches"}
            {d?.length ? ` · ${d.length} dept(s)` : ""}
          </span>
        )
      },
    },
    { key: "isDefault", label: "Default", render: (r) => r.isDefault ? <Star className="h-3.5 w-3.5 text-amber-500" /> : <StarOff className="h-3.5 w-3.5 text-muted-foreground/40" /> },
    {
      key: "active", label: "Status", render: (r) => (
        <StatusBadge state={r.active} />
      ),
    },
    {
      key: "_actions", label: "", render: (r) => can("companies", "assign") ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-rose-500" onClick={() => setRemoveTarget(r)} title="Revoke access">
            Remove
          </Button>
        </div>
      ) : null,
    },
  ]

  const userOptions = (users || []).filter((u: any) => u.role !== "EMPLOYEE").map((u: any) => ({ value: u.id, label: `${u.name} (${u.email})` }))

  const assignFields: FieldDef[] = [
    { name: "userId", label: "User", type: "select", options: userOptions, required: true },
    {
      name: "role", label: "Role in this company", type: "select", required: true, defaultValue: "HR_ADMIN",
      options: ["VENDOR_OWNER", "HR_ADMIN", "HR_MANAGER", "PAYROLL_OFFICER", "BRANCH_MANAGER", "DEPT_MANAGER", "EMPLOYEE"].map((r) => ({ value: r, label: r.replace(/_/g, " ") })),
      help: "The role applies while THIS company is the user's active context — one user can hold different roles in different companies.",
    },
    { name: "isDefault", label: "Make this the user's default company", type: "switch" },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        <select
          className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          value={selected}
          onChange={(e) => setCompanyId(e.target.value)}
          aria-label="Select company"
        >
          {(companies || []).map((c: any) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
        </select>
        <span className="text-xs text-muted-foreground">
          Users who may operate in this company. Access is validated server-side on every request; revoking takes effect immediately.
        </span>
      </div>

      {selected ? (
        <DataTable
          columns={columns}
          rows={data || []}
          loading={loading}
          error={error}
          searchable
          csvName={`company-access-${selected}`}
          emptyTitle="No users assigned"
          emptyHint="Assign users to let them operate in this company with a company-specific role."
          toolbar={can("companies", "assign") ? (
            <Button size="sm" className="gap-1.5" onClick={() => setAssignOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Assign User
            </Button>
          ) : undefined}
        />
      ) : (
        <EmptyState icon={Building2} title="No company selected" hint="Create a company first." />
      )}

      <FormDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title="Assign user to company"
        description={`${(companies || []).find((c: any) => c.id === selected)?.name || "Company"} — the user gets this role while the company is their active context.`}
        fields={assignFields}
        submitLabel="Grant access"
        onSubmit={async (v) => {
          if (!v.userId) throw new Error("Select a user")
          await rpc("companies.access.save", {
            userId: v.userId,
            companyId: selected,
            role: v.role,
            isDefault: !!v.isDefault,
            active: true,
          })
          toast("Access granted", "ok")
          setAssignOpen(false)
          reload()
        }}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(v) => !v && setRemoveTarget(null)}
        title="Revoke company access"
        message={`Remove ${removeTarget?.user?.name}'s access to ${removeTarget?.company?.name || "this company"}? Their session loses this company context immediately (other companies are unaffected).`}
        confirmLabel="Revoke"
        danger
        onConfirm={async () => {
          try {
            await rpc("companies.access.remove", { id: removeTarget.id })
            toast("Access revoked", "ok")
            reload()
          } catch (e: any) {
            toast(String(e?.message || e), "err")
          } finally {
            setRemoveTarget(null)
          }
        }}
      />
    </div>
  )
}

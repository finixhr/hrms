"use client"
// ============ Company Switcher (MULTI-COMPANY 2026-11-03) ============
// Global company context control for the workspace shell. Shows the ACTIVE
// company (logo/code/name) and switches the session's company through
// companies.activate — a SERVER-validated, audited action that writes
// Session.activeCompanyId. The store then re-bootstraps (fresh settings,
// permissions and data), so nothing from the previous company stays visible.
//
// Placement: workspace header (web + desktop shell), next to the design/
// theme controls. Mobile renders the same control (responsive labels).
import { Building2, Check, ChevronsUpDown, Layers } from "lucide-react"
import { useState } from "react"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useHrm } from "./store"
import { tr, useLang } from "./i18n"

export function CompanySwitcher() {
  const lang = useLang()
  const companies = useHrm((s) => s.companies)
  const activeCompanyId = useHrm((s) => s.activeCompanyId)
  const allCompaniesMode = useHrm((s) => s.allCompaniesMode)
  const switchCompany = useHrm((s) => s.switchCompany)
  const can = useHrm((s) => s.can)
  const user = useHrm((s) => s.user)
  const [busy, setBusy] = useState(false)

  // ESS users: their company is fixed by their employment (the switcher is
  // hidden — switching is a manager/admin affordance).
  if (!user || user.role === "EMPLOYEE") return null

  // The All Companies consolidated REPORTING context is permission-gated
  // (companies.consolidated — tenant admins/owners; the server re-validates
  // it on every request).
  const canConsolidate = can("companies", "consolidated")
  const active = companies.find((c) => c.companyId === activeCompanyId) || null
  const label = allCompaniesMode ? "All Companies" : active ? active.name : "All Companies"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy || companies.length === 0}
        className="flex items-center gap-1.5 h-8 px-2 rounded-md border bg-background hover:bg-accent hover:text-accent-foreground transition-colors max-w-[220px] hrm-focus disabled:opacity-60"
        aria-label={tr("Switch company", lang)}
        title={active ? `${active.name} (${active.code})` : tr("Company context", lang)}
      >
        <Building2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="text-xs font-medium truncate hidden sm:inline">{label}</span>
        {active && <span className="text-[10px] text-muted-foreground hidden md:inline">{active.code}</span>}
        <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">
          {tr("Active company", lang)}
        </DropdownMenuLabel>
        {companies.length === 0 && (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {tr("No company access — ask an administrator.", lang)}
          </div>
        )}
        {companies.map((c) => (
          <DropdownMenuItem
            key={c.companyId}
            disabled={busy}
            onClick={async () => {
              if (c.companyId === activeCompanyId) return
              setBusy(true)
              try { await switchCompany(c.companyId) } finally { setBusy(false) }
            }}
            className="gap-2 items-start"
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate flex items-center gap-1.5">
                {c.name}
                {c.isDefault && <span className="text-[9px] px-1 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 font-semibold">DEFAULT</span>}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">
                {c.code} · {c.role.replace(/_/g, " ")}
              </div>
            </div>
            {c.companyId === activeCompanyId && <Check className="h-3.5 w-3.5 text-emerald-600 shrink-0" />}
          </DropdownMenuItem>
        ))}
        {canConsolidate && (
          <DropdownMenuItem
            disabled={busy}
            onClick={async () => {
              if (allCompaniesMode) return
              setBusy(true)
              try { await switchCompany(null) } finally { setBusy(false) }
            }}
            className="gap-2 items-start"
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate flex items-center gap-1.5">
                <Layers className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                All Companies
              </div>
              <div className="text-[10px] text-muted-foreground truncate">
                {tr("Consolidated reporting — read-only", lang)}
              </div>
            </div>
            {allCompaniesMode && <Check className="h-3.5 w-3.5 text-emerald-600 shrink-0" />}
          </DropdownMenuItem>
        )}
        {(companies.length > 1 || canConsolidate) && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[10px] text-muted-foreground leading-relaxed">
              {allCompaniesMode
                ? tr("All Companies is a read-only consolidated view. Switch to a company to make changes.", lang)
                : tr("Switching refreshes the workspace with the selected company's data, settings and your role in it.", lang)}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

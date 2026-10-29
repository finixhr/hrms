"use client"
// ============ App shell — premium compact SaaS workspace chrome ============
// 2026 redesign: adaptive sidebar (light/dark), 60px collapsible icon rail with
// tooltips, sticky 52px header with breadcrumb + module context, refined
// controls. ALL business logic preserved from the previous shell: module
// visibility (settings + permissions), SaaS entitlement gating, subscription
// chips, toast bridge, vendor branding, localization, unread polling,
// security dialogs, i18n, dark mode.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import {
  Bell, ChevronRight, Fingerprint, KeyRound, LogOut, Menu, Moon, ShieldCheck, Store, Sun, UserRound,
  ShieldAlert, Clock, PanelLeftClose, PanelLeftOpen,
} from "lucide-react"

// SaaS layer (client mirror of the server's MODULE_FEATURE_GATES map in
// src/hrm-server/saas/entitlements.ts — the SERVER map is the security
// boundary; this one only hides nav items for a cleaner UX). Keep in sync.
// WP-D — SAAS_GATED_MODULE_FEATURE now lives in module-map.ts (shared with
// the Module Visibility settings card so both surfaces use ONE precedence).
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useHrm } from "./store"
import { SupportBanner } from "./support-banner"
import { MODULE_OF, hiddenModulesOf, SAAS_GATED_MODULE_FEATURE } from "./module-map"
import { toast as renderToast } from "@/hooks/use-toast"
import { NAV } from "./nav"
import { VIEWS } from "./views/registry"
import { tr, useLang, applyTitle, setLang as switchLang } from "./i18n"
import { applyDateFormat, applyLocalization } from "./shared/ui-kit"
import { SecurityMfaDialog, SecurityPasskeysDialog, ChangePasswordDialog } from "./security"
import { GlobalSearch } from "./global-search"
import { PunchAlerts } from "./shared/punch-alerts"
// Platform design systems (Part L §17) — Comet / Cursor 1 / Cursor 2 picker
import { DesignSwitcher } from "./design"
import { APP_BUILD } from "./build-info"
// CHUNK-ERROR FIX (2026-10-12) — contains any view load/render failure so a
// single broken/stale chunk can never unmount the whole workspace again.
import { ViewErrorBoundary } from "./view-error-boundary"
import { cn } from "@/lib/utils"

// Sidebar collapse preference persists per browser (same pattern as the
// theme/language stores — no setState-in-effect, hydration-safe).
const SIDEBAR_KEY = "hrm_sidebar_collapsed"
const sidebarListeners = new Set<() => void>()
function emitSidebar() { sidebarListeners.forEach((l) => l()) }
function subscribeSidebar(cb: () => void) { sidebarListeners.add(cb); return () => { sidebarListeners.delete(cb) } }
function getSidebarSnapshot(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_KEY) === "1" } catch { return false }
}
function writeSidebar(collapsed: boolean) {
  try { window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0") } catch { /* private mode */ }
  emitSidebar()
}

export function AppShell() {
  // L-17 — narrow selectors: destructuring the whole store re-rendered the
  // shell (and the active view with it) on EVERY store change (30s unread
  // polls, toasts, unrelated view state). Selecting each slice directly means
  // the shell only re-renders when one of ITS slices changes.
  const user = useHrm((s) => s.user)
  const vendor = useHrm((s) => s.vendor)
  const view = useHrm((s) => s.view)
  const navigate = useHrm((s) => s.navigate)
  const unread = useHrm((s) => s.unread)
  const logout = useHrm((s) => s.logout)
  const can = useHrm((s) => s.can)
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [securityOpen, setSecurityOpen] = useState(false)
  const [passkeysOpen, setPasskeysOpen] = useState(false)
  const [changePwOpen, setChangePwOpen] = useState(false)
  // hydration-safe persisted collapse (server renders expanded)
  const storedCollapsed = useSyncExternalStore(subscribeSidebar, getSidebarSnapshot, () => false)
  useEffect(() => { setCollapsed(storedCollapsed) }, [storedCollapsed])
  const toggleCollapsed = () => writeSidebar(!collapsed)
  // L1/L5 — hydration-safe language preference (localStorage-backed store)
  const lang = useLang()

  const isEmployeeOnly = user?.role === "EMPLOYEE"

  // keep the browser tab title in sync with the active language
  useEffect(() => {
    applyTitle(lang, vendor?.name)
  }, [lang, vendor?.name])

  // HRM-12 — the global toast pipeline: 34 call-sites write store.toast(), but
  // nothing ever rendered it (audit H-12). This bridge projects every toast onto
  // the mounted Toaster so quick-action feedback is finally visible.
  const toastMsg = useHrm((s2) => s2.toastMsg)
  useEffect(() => {
    if (!toastMsg) return
    renderToast({ title: toastMsg.text, variant: toastMsg.kind === "err" ? "destructive" : undefined })
  }, [toastMsg])

  // HRM-003/L5 — apply the vendor date-format preference whenever settings arrive.
  // M-9 — the active language drives the date LOCALE too (Bangla UI renders
  // Bangla dates + numerals; English pins en-GB), and the vendor localization
  // settings (currency symbol, number grouping, clock) apply app-wide.
  const hrmSettings = useHrm((s2) => s2.settings)
  // SaaS layer — subscription snapshot for entitlement gating + the read-only chip
  const subscription = useHrm((s2) => s2.subscription)
  useEffect(() => {
    applyDateFormat(hrmSettings?.general?.dateFormat, lang === "bn" ? "bn" : "en-GB")
  }, [hrmSettings?.general?.dateFormat, lang])
  useEffect(() => {
    if (hrmSettings?.localization) {
      applyLocalization({
        currencySymbol: hrmSettings.localization.currencySymbol,
        numberFormat: hrmSettings.localization.numberFormat,
        timeFormat: hrmSettings.localization.timeFormat,
      })
    }
  }, [hrmSettings?.localization])

  // B1 — branding: apply vendor primary/accent colors to the CSS variables
  useEffect(() => {
    const b = hrmSettings?.branding
    if (!b?.primaryColor) return
    const root = document.documentElement
    const ok = (hex: string) => /^#[0-9a-fA-F]{6}$/.test(hex)
    if (ok(b.primaryColor)) root.style.setProperty("--hrm-primary", b.primaryColor)
    if (ok(b.accentColor)) root.style.setProperty("--hrm-accent", b.accentColor)
  }, [hrmSettings])

  const navGroups = useMemo(() => {
    // B5/M-08 — module visibility. The settings group stores DISABLED module
    // keys under `modules.disabled`; the shared hiddenModulesOf() resolver
    // (M-21) reads the legacy key once so pre-rename deployments keep their
    // configuration — global search uses the SAME resolver.
    const hiddenModules = hiddenModulesOf(hrmSettings)
    // M-08 — the view→module map lives in ONE shared constant (module-map.ts).
    const moduleOf = (viewKey: string) => MODULE_OF[viewKey]
    return NAV.map((g) => ({
      ...g,
      items: g.items.filter((it) => {
        const mod = moduleOf(it.key)
        if (mod && hiddenModules.has(mod)) return false
        // SaaS layer — per-tenant module overrides (SaaS Owner Console →
        // Tenants → Overrides) hide/show ANY module, core or plan-gated,
        // mirroring the server's featureBlocked() precedence: an explicit
        // override always wins.
        if (mod && subscription?.overrides && typeof subscription.overrides[mod] === "boolean") {
          if (subscription.overrides[mod] === false) return false
        }
        // SaaS layer — plan entitlements hide gated modules (payroll family,
        // AIT, inventory, procurement, performance, camera, tracking,
        // geofence, ESS, analytics). Server-side enforcement is the boundary;
        // this is UX only. LEGACY tenants keep everything.
        if (subscription?.mode === "SUBSCRIBED" && subscription.features && mod && SAAS_GATED_MODULE_FEATURE[mod]) {
          if (subscription.features[SAAS_GATED_MODULE_FEATURE[mod]] === false) return false
        }
        if (it.key === "ess") return !!user?.employeeId || isEmployeeOnly
        if (!it.perm) return true
        return can(it.perm[0], it.perm[1])
      }),
    })).filter((g) => g.items.length > 0)
  }, [user, can, isEmployeeOnly, hrmSettings, subscription])

  const ActiveView = VIEWS[view.key] || VIEWS.dashboard

  // Header breadcrumb — the active destination resolved against NAV so the
  // user always knows WHERE they are (group + page) without a bloated title.
  const crumb = useMemo(() => {
    for (const g of navGroups) {
      const item = g.items.find((it) => it.key === view.key)
      if (item) return { group: g.label, item }
    }
    return null
  }, [navGroups, view.key])

  // refresh unread badge periodically — M-15: only while a session is ACTIVE;
  // a logged-out tab must not keep hammering the API (401 noise + load).
  useEffect(() => {
    if (!user) return
    const t = setInterval(() => {
      const s = useHrm.getState()
      if (!s.user) return // session ended mid-flight — skip this tick
      s.refreshUnread()
    }, 30000)
    return () => clearInterval(t)
  }, [user])

  const initials = (user?.name || "?").split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase()

  // Sidebar renderer — takes an explicit collapsed flag so the mobile drawer
  // always shows the expanded form regardless of the desktop collapse state.
  const renderSidebar = (isCollapsed: boolean) => (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* brand */}
      <div className={cn("flex items-center gap-2.5 h-[52px] px-3 border-b border-sidebar-border shrink-0", isCollapsed && "justify-center px-0")}>
        {vendor?.logoUrl ? (
          <img src={vendor.logoUrl} alt="Company logo" className="h-8 w-8 rounded-lg object-contain bg-white/95 shrink-0 ring-1 ring-black/5" />
        ) : (
          <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 shadow-sm"
            style={{ background: "linear-gradient(135deg, var(--hrm-accent, #34d399), var(--hrm-primary, #059669))" }}>
            <Store className="h-4 w-4 text-white" />
          </div>
        )}
        {!isCollapsed && (
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-tight truncate text-slate-900 dark:text-slate-100">{vendor?.name || "Finix HR"}</p>
            <p className="text-[10px] text-muted-foreground tracking-wide uppercase">HRM Workspace</p>
          </div>
        )}
        {!isCollapsed && (
          <button onClick={toggleCollapsed} aria-label="Collapse sidebar"
            className="hidden lg:flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors hrm-focus">
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-4 scroll-thin" aria-label="Main navigation">
        {navGroups.map((g) => (
          <div key={g.label}>
            {!isCollapsed && <p className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">{tr(g.label, lang)}</p>}
            <div className="space-y-0.5">
              {g.items.map((it) => {
                const Icon = it.icon
                const active = view.key === it.key
                const item = (
                  <button key={it.key} onClick={() => { navigate(it.key); setMobileOpen(false) }}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative w-full flex items-center gap-2.5 rounded-md px-2 h-8 text-[13px] font-medium transition-colors text-left hrm-focus",
                      active
                        ? "hrm-nav-active"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      isCollapsed && "justify-center px-0",
                    )}>
                    <Icon className="h-4 w-4 shrink-0" strokeWidth={active ? 2.2 : 1.8} />
                    {!isCollapsed && <span className="truncate">{tr(it.label, lang)}</span>}
                    {!isCollapsed && it.key === "notifications" && unread > 0 && (
                      <span className="ml-auto rounded-full bg-rose-500 text-white text-[10px] px-1.5 leading-[16px] font-bold tabular-nums">{unread}</span>
                    )}
                    {isCollapsed && it.key === "notifications" && unread > 0 && (
                      <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-rose-500" />
                    )}
                  </button>
                )
                // collapsed rail: tooltip with the full label
                if (isCollapsed) {
                  return (
                    <Tooltip key={it.key}>
                      <TooltipTrigger asChild>{item}</TooltipTrigger>
                      <TooltipContent side="right" sideOffset={6} className="text-xs">
                        {tr(it.label, lang)}
                        {it.key === "notifications" && unread > 0 ? ` · ${unread}` : ""}
                      </TooltipContent>
                    </Tooltip>
                  )
                }
                return item
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* footer: sign out (WP-D — the language switcher moved to the top bar) */}
      <div className="px-2 pb-2 pt-2 border-t border-sidebar-border shrink-0 space-y-1">
        <button onClick={() => logout()} className={cn("w-full flex items-center gap-2.5 rounded-md px-2 h-8 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors hrm-focus", isCollapsed && "justify-center")}>
          <LogOut className="h-4 w-4" /> {!isCollapsed && tr("Sign out", lang)}
        </button>
        {/* visible build tag — one-glance check that the running server serves
            this code (stale folder / un-rebuilt bundle shows an older tag) */}
        {!isCollapsed && (
          <p className="text-center text-[10px] text-muted-foreground/70 select-none" data-build={APP_BUILD}>
            build {APP_BUILD}
          </p>
        )}
      </div>
    </div>
  )

  const expandButton = collapsed && (
    <button onClick={toggleCollapsed} aria-label="Expand sidebar"
      className="hidden lg:flex h-7 w-7 items-center justify-center rounded-md border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-colors hrm-focus shadow-sm">
      <PanelLeftOpen className="h-4 w-4" />
    </button>
  )

  return (
    <div className="min-h-screen bg-background flex">
      {/* desktop sidebar */}
      <TooltipProvider delayDuration={120}>
        <aside
          // Geometry follows the shell tokens (--hrm-sidebar-w / --hrm-sidebar-rail)
          // so design variants can retune it — defaults match the previous
          // hardcoded 244px / 60px exactly (Comet is pixel-identical).
          className={cn("hidden lg:flex flex-col shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-in-out", collapsed ? "w-[var(--hrm-sidebar-rail,60px)]" : "w-[var(--hrm-sidebar-w,244px)]")}
          style={{ height: "100vh", position: "sticky", top: 0 }}>
          {renderSidebar(collapsed)}
        </aside>
      </TooltipProvider>

      {/* mobile sidebar drawer (hamburger in the header controls it) */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-[264px] p-0 border-0 bg-sidebar [&>button]:text-muted-foreground [&>button:hover]:text-foreground [&>button:hover]:opacity-100"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {renderSidebar(false)}
        </SheetContent>
      </Sheet>

      <div className="flex-1 flex flex-col min-w-0">
        {/* header — sticky, compact, with breadcrumb module context. Height
            follows the --hrm-header-h token (design variants retune it; the
            52px default matches the previous hardcoded value). */}
        <header className="sticky top-0 z-30 h-[var(--hrm-header-h,52px)] bg-background/85 dark:bg-background/85 backdrop-blur-md border-b flex items-center gap-1.5 px-2.5 sm:px-4 shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-4.5 w-4.5" />
          </Button>
          {expandButton}
          {/* breadcrumb / module context */}
          <nav aria-label="Breadcrumb" className="hidden sm:flex items-center gap-1.5 min-w-0 pl-0.5">
            {crumb ? (
              <>
                <span className="text-[13px] text-muted-foreground hidden md:inline truncate">{tr(crumb.group, lang)}</span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 hidden md:block shrink-0" />
                <span className="text-[13px] font-semibold text-foreground truncate">{tr(crumb.item.label, lang)}</span>
              </>
            ) : (
              <span className="text-[13px] font-semibold text-foreground">{vendor?.name || "Finix HR"}</span>
            )}
          </nav>
          <div className="flex-1" />
          {subscription?.readonly && (
            <button
              onClick={() => { if (can("subscription", "view")) navigate("subscription") }}
              className="hidden sm:flex items-center gap-1.5 rounded-full border border-red-300/80 bg-red-50 dark:bg-red-950/60 dark:border-red-900 px-2.5 py-1 text-[11px] font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60 transition-colors"
              title="Your subscription is not active — the workspace is read-only. Click for details."
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              Read-only · subscription {String(subscription.status).toLowerCase()}
            </button>
          )}
          {!subscription?.readonly && subscription?.mode === "SUBSCRIBED" && subscription.daysRemaining != null && subscription.daysRemaining >= 0 && subscription.daysRemaining <= 14 && (
            <button
              onClick={() => { if (can("subscription", "view")) navigate("subscription") }}
              className="hidden sm:flex items-center gap-1.5 rounded-full border border-amber-300/80 bg-amber-50 dark:bg-amber-950/60 dark:border-amber-900 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-100 transition-colors"
              title="Subscription renewal is coming up. Click for details."
            >
              <Clock className="h-3.5 w-3.5" />
              Renews in {subscription.daysRemaining}d
            </button>
          )}
          {/* 2026-10-07 — app-wide real-time punch toasts (renders nothing) */}
          <PunchAlerts />
          <GlobalSearch />
          {/* WP-D (2026-10-08) — the EN|বাংলা switcher moved from the sidebar footer
              to the TOP BAR beside the theme toggle: compact segmented control,
              same setLang behavior, hydration-safe store, keyboard accessible. */}
          <div className="flex items-center rounded-md bg-accent/70 dark:bg-accent/40 p-0.5 shrink-0" role="group" aria-label="Interface language">
            {(["en", "bn"] as const).map((l) => (
              <button
                key={l}
                onClick={() => switchLang(l)}
                aria-pressed={lang === l}
                title={l === "en" ? "English" : "বাংলা (বাংলাদেশ) — ইন্টারফেস ভাষা"}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors hrm-focus",
                  lang === l ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {l === "en" ? "EN" : "বাং"}
              </button>
            ))}
          </div>
          {/* Part L §17 — workspace design picker (Comet / Cursor 1 / 2),
              grouped with the theme toggle: appearance lives together */}
          <DesignSwitcher surface="app" />
          <DarkModeToggle />
          <button onClick={() => navigate("notifications")} className="relative h-8 w-8 rounded-md hover:bg-accent hover:text-accent-foreground flex items-center justify-center transition-colors hrm-focus" aria-label="Notifications">
            <Bell className="h-4 w-4 text-muted-foreground" />
            {unread > 0 && <span className="absolute top-0.5 right-0.5 h-3.5 min-w-3.5 rounded-full bg-rose-500 text-white text-[9px] font-bold px-1 flex items-center justify-center ring-2 ring-background">{unread}</span>}
          </button>
          {user?.employeeId && (
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5 hidden md:inline-flex" onClick={() => navigate("ess")}>
              <UserRound className="h-3.5 w-3.5" /> My Portal
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent transition-colors hrm-focus" aria-label="Account menu">
                <Avatar className="h-7 w-7">
                  {/* R2 — tagged employee's photo as the user's profile picture */}
                  {user?.employeePhotoUrl && <AvatarImage src={user.employeePhotoUrl} alt={user?.name || "profile"} />}
                  <AvatarFallback className="bg-primary/15 text-primary dark:text-primary text-[11px] font-bold">{initials}</AvatarFallback>
                </Avatar>
                <div className="hidden md:block text-left">
                  <p className="text-xs font-semibold leading-none">{user?.name}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{user?.roleLabel}</p>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-xs">
                <p className="font-semibold">{user?.name}</p>
                <p className="text-muted-foreground font-normal">{user?.email}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {user?.employeeId && (
                <DropdownMenuItem onClick={() => navigate("ess")} className="text-xs">
                  <UserRound className="h-3.5 w-3.5 mr-2" /> Employee Self-Service
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => navigate("notifications")} className="text-xs">
                <Bell className="h-3.5 w-3.5 mr-2" /> Notifications {unread > 0 && <Badge className="ml-auto bg-rose-500 text-[9px]">{unread}</Badge>}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSecurityOpen(true)} className="text-xs">
                <ShieldCheck className="h-3.5 w-3.5 mr-2" /> Security &amp; MFA
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPasskeysOpen(true)} className="text-xs">
                <Fingerprint className="h-3.5 w-3.5 mr-2" /> Passkeys &amp; Biometrics
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setChangePwOpen(true)} className="text-xs">
                <KeyRound className="h-3.5 w-3.5 mr-2" /> Change Password
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => logout()} className="text-xs text-rose-600 focus:text-rose-600">
                <LogOut className="h-3.5 w-3.5 mr-2" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* content */}
        <main className="flex-1 p-3 sm:p-4 lg:px-5 lg:py-4 min-w-0">
          {/* Wave 10 — persistent SUPPORT ACCESS banner (third session plane) */}
          <SupportBanner />
          <div className="mx-auto max-w-[1440px]">
            {/* key remounts the boundary per navigation, so a failed view never
                poisons the next one; the boundary keeps a transient chunk error
                (or a view crash) contained to this card instead of the SPA */}
            <div key={view.key + JSON.stringify(view.params || {})} className="hrm-view-in">
              <ViewErrorBoundary>
                <ActiveView />
              </ViewErrorBoundary>
            </div>
          </div>
        </main>

        <footer className="mt-auto border-t bg-card py-2.5 px-5 text-center text-[11px] text-muted-foreground">
          {vendor?.name} — Finix HR · Multi-tenant workforce platform · Secured with role-based action permissions &amp; audit trail
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          <span className="text-muted-foreground/70" data-build={APP_BUILD}>build {APP_BUILD}</span>
        </footer>
      </div>

      {/* account self-service dialogs (HRM-006/007 + passkey MFA) */}
      <SecurityMfaDialog open={securityOpen} onOpenChange={setSecurityOpen} />
      <SecurityPasskeysDialog open={passkeysOpen} onOpenChange={setPasskeysOpen} />
      <ChangePasswordDialog open={changePwOpen} onOpenChange={setChangePwOpen} />
    </div>
  )
}

// ================= Dark / Night mode toggle =================
// Tailwind darkMode:"class" — toggles <html class="dark">. Preference persists
// per browser (localStorage hrm_theme) via the same useSyncExternalStore
// pattern as the language switcher (no setState-in-effect, no hydration
// mismatch). First visit honors the vendor branding default (Settings →
// Localization → Dark mode by default); an explicit click always wins.
const THEME_KEY = "hrm_theme"

const themeListeners = new Set<() => void>()
function emitTheme() { themeListeners.forEach((l) => l()) }
function subscribeTheme(cb: () => void) { themeListeners.add(cb); return () => { themeListeners.delete(cb) } }
function getThemeSnapshot(): "dark" | "light" | null {
  const v = window.localStorage.getItem(THEME_KEY)
  return v === "dark" || v === "light" ? v : null
}
function writeTheme(next: "dark" | "light") {
  window.localStorage.setItem(THEME_KEY, next)
  emitTheme()
}

export function DarkModeToggle() {
  const brandingDefault = useHrm((s) => s.settings?.branding?.darkModeDefault === true)
  const stored = useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => null as "dark" | "light" | null)
  const dark = stored != null ? stored === "dark" : brandingDefault // explicit preference wins, else vendor default

  // apply/remove the class as a pure DOM side effect
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])

  return (
    <button
      type="button"
      onClick={() => writeTheme(dark ? "light" : "dark")}
      className="h-8 w-8 rounded-md hover:bg-accent hover:text-accent-foreground flex items-center justify-center transition-colors hrm-focus"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark
        ? <Sun className="h-4 w-4 text-amber-500" />
        : <Moon className="h-4 w-4 text-muted-foreground" />}
    </button>
  )
}

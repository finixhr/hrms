"use client"
// ============ Owner console shell — session gate + sidebar + topbar ============
// Responsive: ≥lg shows the fixed sidebar; <lg gets a slide-in drawer
// (hamburger in the topbar) with scroll-lock — every nav item remains
// reachable on phones, per the console mobile-responsiveness requirement.
import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Activity, Archive, Bell, Boxes, Building2, ChevronRight, FileSearch, Gauge, HardDrive, Image as ImageIcon, Landmark, LayoutDashboard, LogIn, LogOut, ArrowLeftRight,
  Megaphone, Menu, PieChart, Radar, ScrollText, Settings as SettingsIcon, ShieldAlert, ShieldCheck, Sparkles, TrendingUp, UsersRound, Wallet, Workflow, X, Send, KeyRound, LifeBuoy,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ownerRpc, saveOwnerCsrf } from "./client"
import { Loading } from "./ui"
import { OwnerThemeToggle, OwnerThemeSync } from "./theme"
// Platform design systems (Part L §17) — Comet / Cursor 1 / Cursor 2 picker,
// shared with the tenant app (per-surface preference via localStorage)
import { DesignSwitcher } from "@/hrm/design"

export type OwnerSession = {
  id: string
  name: string
  email: string
  roleKey: string
  permissions: string[]
  mfaEnrolled?: boolean
}

const NAV: { group: string; items: { href: string; label: string; icon: any; perm: string }[] }[] = [
  {
    group: "Overview",
    items: [{ href: "/owner", label: "Dashboard", icon: LayoutDashboard, perm: "dashboard.view" }],
  },
  {
    group: "Sales & Onboarding",
    items: [
      { href: "/owner/registrations", label: "Registration Applications", icon: FileSearch, perm: "registrations.view" },
      { href: "/owner/inquiries", label: "Contact Inquiries", icon: Megaphone, perm: "inquiries.view" },
      // R11 — marketing/promotional email+SMS campaigns to tenant admins
      { href: "/owner/communication", label: "Communication", icon: Send, perm: "communication.view" },
    ],
  },
  {
    group: "Customers",
    items: [{ href: "/owner/tenants", label: "Tenants", icon: Building2, perm: "tenants.view" }],
  },
  {
    // Phase 5 P0 (Scope 5) — observability console: per-tenant fleet health
    // (set-based, SQL-computed tiers) + the live RPC performance panel.
    group: "Observability",
    items: [
      { href: "/owner/fleet", label: "Fleet Health", icon: Radar, perm: "tenants.view" },
      { href: "/owner/performance", label: "Performance", icon: Gauge, perm: "health.view" },
    ],
  },
  {
    // Phase 5 P1 — lifecycle & quota governance: the subscription lifecycle
    // stage/pipeline/event console + the fleet-wide quota utilization matrix.
    group: "Lifecycle & Quotas",
    items: [
      { href: "/owner/lifecycle", label: "Lifecycle Console", icon: Workflow, perm: "subscriptions.view" },
      { href: "/owner/quotas", label: "Quota Utilization", icon: Boxes, perm: "tenants.view" },
      // Part J §15 — platform-wide storage monitoring (allocation, per-tenant
      // utilization bands, provider/object split, UsageSnapshot trend)
      { href: "/owner/storage", label: "Storage", icon: HardDrive, perm: "tenants.view" },
    ],
  },
  {
    group: "Subscriptions & Billing",
    items: [
      { href: "/owner/plans", label: "Plans", icon: PieChart, perm: "plans.view" },
      { href: "/owner/subscriptions", label: "Subscriptions", icon: Landmark, perm: "subscriptions.view" },
      { href: "/owner/renewals", label: "Renewals", icon: ChevronRight, perm: "subscriptions.view" },
      // Wave 3 WP-C — tenant-submitted plan-change request queue
      { href: "/owner/planchanges", label: "Plan Requests", icon: ArrowLeftRight, perm: "subscriptions.view" },
      { href: "/owner/billing", label: "Revenue & Collections", icon: Wallet, perm: "billing.view" },
    ],
  },
  {
    // Phase 5 P3 — growth & engagement console: signup/MRR/funnel/churn
    // growth KPIs, fleet-wide usage metering (the UsageSnapshot series) and
    // the per-tenant login-intensity matrix; gated like the Tenants page.
    group: "Growth & Engagement",
    items: [
      { href: "/owner/analytics", label: "Growth & Engagement", icon: TrendingUp, perm: "tenants.view" },
    ],
  },
  {
    // Phase 5 P4 — the security surfaces pulled into their own group, headed
    // by the new Security & Trust console (posture + session governance)
    group: "Security & Governance",
    items: [
      // Wave 10 (2026-10-24) — Time-Limited Support Access control room
      { href: "/owner/support", label: "Support Access", icon: LifeBuoy, perm: "support.access" },
      // Phase 5 P4 — security posture + live session governance (read-only)
      { href: "/owner/security", label: "Security Console", icon: ShieldAlert, perm: "audit.view" },
      { href: "/owner/audit", label: "Platform Audit", icon: ScrollText, perm: "audit.view" },
      // R16 — login attempt audit (success + failure, IP/device/browser,
      // both planes; retention-swept)
      { href: "/owner/loginaudit", label: "Login Audit", icon: KeyRound, perm: "audit.view" },
      { href: "/owner/users", label: "Owner Users", icon: UsersRound, perm: "users.view" },
      { href: "/owner/roles", label: "Roles & Permissions", icon: ShieldCheck, perm: "roles.view" },
    ],
  },
  {
    group: "Administration",
    items: [
      // Wave 2 WP-Q — full media library (folders, variants, dedupe, backfill);
      // the Website Studio's inline Media tab remains as the light picker view
      { href: "/owner/media", label: "Media Library", icon: ImageIcon, perm: "cms.view" },
      // Wave 2 WP-N — live system health checks (app/db/jobs/email/sms/devices/cameras/backup/disk/ssl)
      { href: "/owner/health", label: "System Health", icon: Activity, perm: "health.view" },
      // Wave 2 WP-R — backup engine + restore drills (gated on settings.view; run actions need settings.manage)
      { href: "/owner/backup", label: "Backup & Recovery", icon: Archive, perm: "settings.view" },
      { href: "/owner/settings", label: "Platform Settings", icon: SettingsIcon, perm: "settings.view" },
    ],
  },
]

export function OwnerShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [session, setSession] = useState<OwnerSession | null>(null)
  const [branding, setBranding] = useState<{ platformName?: string; logoUrl?: string } | null>(null)
  const [state, setState] = useState<"loading" | "unauthed" | "ready">("loading")
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await ownerRpc<{ owner: OwnerSession; branding?: { platformName?: string; logoUrl?: string } }>("owner.auth.me")
        if (!cancelled) {
          setSession(data.owner)
          if (data.branding) setBranding(data.branding)
          setState("ready")
        }
      } catch {
        if (!cancelled) setState("unauthed")
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (state === "unauthed") router.replace("/owner/login")
  }, [state, router])

  // close the mobile drawer on route change (back button / link clicks that
  // navigate without unmounting the shell)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setDrawerOpen(false))
    return () => cancelAnimationFrame(raf)
  }, [pathname])

  // scroll-lock while the drawer is open
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [drawerOpen])

  const logout = async () => {
    try { await ownerRpc("owner.auth.logout") } catch { /* ignore */ }
    saveOwnerCsrf(null)
    router.replace("/owner/login")
  }

  if (state === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 light:bg-slate-50">
        <Loading label="Opening the owner console…" />
      </div>
    )
  }
  if (state === "unauthed" || !session) return null

  const perms = new Set(session.permissions)
  const visibleNav = NAV.map((g) => ({ ...g, items: g.items.filter((it) => !it.perm || perms.has(it.perm)) })).filter((g) => g.items.length > 0)

  return (
    <div className="min-h-dvh bg-slate-950 light:bg-slate-50">
      <OwnerThemeSync />
      <div className="mx-auto flex max-w-[1600px]">
        {/* sidebar (≥lg) */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 lg:flex">
          <div className="flex h-16 items-center gap-2.5 border-b border-white/10 light:border-slate-200 px-4">
            {branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.platformName || "Finix HR"} className="h-8 max-w-28 object-contain rounded" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500 shadow-lg shadow-indigo-950/60">
                <Sparkles className="h-4 w-4 text-white light:text-slate-900" />
              </span>
            )}
            <div className="min-w-0">
              <p className="text-sm font-bold leading-tight text-white light:text-slate-900 truncate">{branding?.platformName || "Finix HR"}</p>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-indigo-300 light:text-indigo-700/80 light:text-indigo-700">Owner Console</p>
            </div>
          </div>
          <nav className="flex-1 overflow-y-auto scroll-thin px-2 py-3">
            {visibleNav.map((g) => (
              <NavGroup key={g.group} group={g.group} items={g.items} pathname={pathname} />
            ))}
          </nav>
          <SidebarFooter session={session} logout={logout} />
        </aside>

        {/* mobile drawer (<lg) */}
        {drawerOpen && (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Console navigation">
            <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50 shadow-2xl">
              <div className="flex h-16 items-center justify-between gap-2.5 border-b border-white/10 light:border-slate-200 px-4">
                <div className="flex items-center gap-2.5">
                  {branding?.logoUrl ? (
                    <img src={branding.logoUrl} alt={branding.platformName || "Finix HR"} className="h-8 max-w-28 object-contain rounded" />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500">
                      <Sparkles className="h-4 w-4 text-white light:text-slate-900" />
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-bold leading-tight text-white light:text-slate-900 truncate">{branding?.platformName || "Finix HR"}</p>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-indigo-300 light:text-indigo-700">Owner Console</p>
                  </div>
                </div>
                <button type="button" onClick={() => setDrawerOpen(false)} aria-label="Close navigation" className="rounded-lg p-2 text-slate-400 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="flex-1 overflow-y-auto scroll-thin px-2 py-3">
                {visibleNav.map((g) => (
                  <NavGroup key={g.group} group={g.group} items={g.items} pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
                ))}
              </nav>
              <SidebarFooter session={session} logout={logout} />
            </aside>
          </div>
        )}

        {/* main */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50/85 light:bg-white/90 px-4 backdrop-blur-xl sm:px-6">
            <button
              type="button"
              className="rounded-lg p-2 text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900 lg:hidden"
              aria-label={drawerOpen ? "Close menu" : "Open menu"}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </button>
            <Link href="/owner" className="flex items-center gap-2 lg:hidden">
              {branding?.logoUrl ? (
                <img src={branding.logoUrl} alt={branding.platformName || "Finix HR"} className="h-7 max-w-24 object-contain rounded" />
              ) : (
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-500">
                  <LogIn className="h-3.5 w-3.5 text-white light:text-slate-900" />
                </span>
              )}
              <span className="text-sm font-bold text-white light:text-slate-900">Owner</span>
            </Link>
            <p className="hidden text-sm text-slate-500 lg:block">
              Signed in as <span className="font-semibold text-slate-300 light:text-slate-700">{session.name}</span> ·{" "}
              {session.roleKey.replace(/_/g, " ").toLowerCase()}
            </p>
            <div className="ml-auto flex items-center gap-2">
              <OwnerNotificationsBell />
              <OwnerThemeToggle />
              {/* Part L §17 — workspace design picker (owner_design key) */}
              <DesignSwitcher surface="owner" />
              <span className="hidden items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-300 light:text-emerald-700 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-700 sm:flex">
                <Bell className="h-3 w-3" /> Platform plane — isolated from tenant data
              </span>
            </div>
          </header>
          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  )
}

function NavGroup({ group, items, pathname, onNavigate }: {
  group: string
  items: { href: string; label: string; icon: any; perm: string }[]
  pathname: string
  onNavigate?: () => void
}) {
  return (
    <div className="mb-4">
      <p className="px-2 mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-600 light:text-slate-500">{group}</p>
      {items.map((it) => {
        const active = pathname === it.href || (it.href !== "/owner" && pathname.startsWith(it.href))
        return (
          <Link
            key={it.href}
            href={it.href}
            onClick={onNavigate}
            className={cn(
              "mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
              active
                ? "bg-gradient-to-r from-blue-600/90 to-violet-600/90 text-white light:text-slate-900 shadow-lg shadow-indigo-950/40"
                : "text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900"
            )}
          >
            <it.icon className="h-4 w-4 shrink-0" /> {it.label}
          </Link>
        )
      })}
    </div>
  )
}

function SidebarFooter({ session, logout }: { session: OwnerSession; logout: () => void }) {
  const initials = session.name.split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase()
  return (
    <div className="border-t border-white/10 light:border-slate-200 p-3">
      <div className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] light:bg-slate-100/60 p-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-[11px] font-bold text-white light:text-slate-900">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-white light:text-slate-900">{session.name}</p>
          <p className="truncate text-[10px] text-slate-500">{session.email}</p>
        </div>
        <button onClick={logout} title="Sign out" aria-label="Sign out" className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 light:hover:bg-slate-100 hover:text-red-400 light:hover:text-red-600">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
      <Link href="/" className="mt-2 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-slate-500 hover:text-slate-300 light:hover:text-slate-700">
        <ShieldCheck className="h-3.5 w-3.5" /> Public website
      </Link>
    </div>
  )
}

// ================= Platform notifications bell =================
// Dropdown feed of the platform gateway's delivery attempts (NOTIFICATION_* audit
// entries — sent, skipped and failed). Loaded lazily on first open; refreshed
// on every open. Same data the Audit page shows, distilled to notifications.
function OwnerNotificationsBell() {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<{
    id: string; action: string; summary: string; createdAt: string
  }[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const toggle = () => {
    // state changes live in the CLICK handler (never synchronously inside an
    // effect body) — the effect below only reacts to `open` flips asynchronously
    setOpen((v) => {
      const next = !v
      if (next && loaded) {
        // refresh on every open: fire the async fetch from the handler
        setLoading(true)
        ownerRpc<{ rows: typeof rows }>("owner.notifications.list", { take: 20 })
          .then((d) => setRows(d.rows || []))
          .catch(() => {})
          .finally(() => setLoading(false))
      }
      return next
    })
  }

  useEffect(() => {
    if (!open || loaded) return
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (cancelled) return
      setLoading(true)
      ownerRpc<{ rows: typeof rows }>("owner.notifications.list", { take: 20 })
        .then((d) => { if (!cancelled) { setRows(d.rows || []); setLoaded(true) } })
        .catch(() => { if (!cancelled) setRows([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    })
    return () => { cancelled = true; cancelAnimationFrame(raf) }
  }, [open, loaded])

  const tone = (action: string) =>
    action.endsWith("_SENT") ? "text-emerald-300 light:text-emerald-700"
    : action.endsWith("_FAILED") ? "text-red-300 light:text-red-600"
    : "text-slate-400 light:text-slate-600"

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label="Platform notifications"
        title="Platform notifications (gateway delivery feed)"
        className="relative rounded-lg p-2 text-slate-400 light:text-slate-600 transition-colors hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900 light:text-slate-500 light:hover:bg-slate-100 light:hover:text-slate-900"
      >
        <Bell className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <>
          <button type="button" aria-hidden className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-96 max-w-[92vw] overflow-hidden rounded-xl border border-white/10 light:border-slate-200 bg-slate-900 shadow-2xl light:border-slate-200 light:bg-white">
            <div className="flex items-center justify-between border-b border-white/10 light:border-slate-200 px-4 py-3 light:border-slate-200">
              <p className="text-xs font-bold text-white light:text-slate-900">Platform notifications</p>
              <Link href="/owner/audit" onClick={() => setOpen(false)} className="text-[11px] text-indigo-300 light:text-indigo-700 hover:underline light:text-indigo-600">
                Full audit →
              </Link>
            </div>
            <div className="max-h-80 overflow-y-auto scroll-thin">
              {loading && !loaded ? (
                <p className="px-4 py-6 text-center text-xs text-slate-500">Loading…</p>
              ) : rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-slate-500">
                  No notifications yet. Gateway delivery attempts (email/SMS to owners and applicants) appear here.
                </p>
              ) : (
                rows.map((r) => (
                  <div key={r.id} className="border-b border-white/5 light:border-slate-200 px-4 py-2.5 last:border-0 light:border-slate-100">
                    <p className={`text-[11px] font-semibold ${tone(r.action)}`}>{r.action.replace("NOTIFICATION_", "")}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-300 light:text-slate-700 light:text-slate-600">{r.summary}</p>
                    <p className="mt-1 text-[10px] text-slate-500">{new Date(r.createdAt).toLocaleString()}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

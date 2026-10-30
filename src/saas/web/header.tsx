"use client"
// ============ Public site header (client: mobile menu + active link) ============
// CMS-driven: nav + identity arrive as props from the server layout
// (src/app/(public)/layout.tsx reads them via getSiteSettings()).
import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronDown, Menu, Sparkles, X } from "lucide-react"
import type { SiteIdentity, SiteNav } from "./content-types"
import { SiteThemeToggle } from "./theme"
import { cn } from "@/lib/utils"

export function SiteHeader({ nav, identity }: { nav: SiteNav; identity: SiteIdentity }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [featuresOpen, setFeaturesOpen] = useState(false)

  // lock scroll while the mobile drawer is open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [open])

  // Close the mobile drawer + mega-menu whenever the route changes (back
  // button, redirects). Nav links below also close the drawer on click for
  // immediacy; this effect only catches navigations that don't pass through
  // them. All setState lives INSIDE the rAF callback — asynchronous by
  // construction, so no cascading render can be triggered from the effect body.
  useEffect(() => {
    const raf = requestAnimationFrame(() => { setOpen(false); setFeaturesOpen(false) })
    return () => cancelAnimationFrame(raf)
  }, [pathname])

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-slate-950/85 backdrop-blur-xl light:border-slate-200 light:bg-white/85">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label={`${identity.siteName} home`}>
          {identity.logoUrl && identity.logoUrl !== "/logo.svg" ? (
            <img src={identity.logoUrl} alt={identity.siteName} className="h-8 w-8 rounded-lg object-contain" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500 shadow-lg shadow-indigo-950/60">
              <Sparkles className="h-4 w-4 text-white" />
            </span>
          )}
          <span className="text-[15px] font-bold tracking-tight text-white light:text-slate-900">
            {identity.siteName}
            <span className="ml-1.5 hidden text-[10px] font-semibold uppercase tracking-widest text-indigo-300/80 light:text-indigo-600/80 sm:inline">HRM</span>
          </span>
        </Link>

        {/* desktop nav */}
        <nav className="ml-6 hidden items-center gap-1 lg:flex" aria-label="Main">
          {nav.map((item) =>
            item.children ? (
              <div key={item.href} className="relative"
                onMouseEnter={() => setFeaturesOpen(true)}
                onMouseLeave={() => setFeaturesOpen(false)}>
                <button
                  type="button"
                  onClick={() => setFeaturesOpen((v) => !v)}
                  aria-expanded={featuresOpen}
                  className={cn(
                    "flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    pathname.startsWith("/features") ? "text-white light:text-slate-900" : "text-slate-300 hover:text-white light:text-slate-600 light:hover:text-slate-900"
                  )}
                >
                  {item.label}
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", featuresOpen && "rotate-180")} />
                </button>
                {featuresOpen && (
                  <div className="absolute left-0 top-full w-[560px] max-w-[calc(100vw-2rem)] pt-2">
                    <div className="rounded-2xl border border-white/10 bg-slate-900/95 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl light:border-slate-200 light:bg-white/95 light:shadow-slate-900/10">
                      <div className="grid grid-cols-2 gap-1">
                        {item.children.map((c) => (
                          <Link
                            key={c.href}
                            href={c.href}
                            className="rounded-xl px-3 py-2.5 transition-colors hover:bg-white/5 light:hover:bg-slate-100"
                          >
                            <span className="block text-sm font-semibold text-white light:text-slate-900">{c.label}</span>
                            <span className="mt-0.5 block text-xs text-slate-400 light:text-slate-500">{c.desc}</span>
                          </Link>
                        ))}
                      </div>
                      <div className="mt-2 border-t border-white/10 px-3 pt-3 light:border-slate-200">
                        <Link href="/features" className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 light:text-indigo-600 light:hover:text-indigo-500">
                          Browse all features →
                        </Link>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  pathname === item.href ? "text-white light:text-slate-900" : "text-slate-300 hover:text-white light:text-slate-600 light:hover:text-slate-900"
                )}
              >
                {item.label}
              </Link>
            )
          )}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <SiteThemeToggle />
          <Link
            href={identity.navSignInHref || "/login"}
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:text-white light:text-slate-600 light:hover:text-slate-900 sm:block"
          >
            {identity.navSignInLabel || "Sign in"}
          </Link>
          <Link
            href={identity.navCtaHref || "/register"}
            data-cursor="magnetic"
            className="rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-950/50 transition-all hover:from-blue-500 hover:to-violet-500 hover:shadow-indigo-900/60"
          >
            {identity.navCtaLabel || "Get Started"}
          </Link>
          <button
            type="button"
            className="rounded-lg p-2 text-slate-300 hover:text-white light:text-slate-600 light:hover:text-slate-900 lg:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* mobile drawer */}
      {open && (
        <div className="lg:hidden">
          <nav className="mx-auto max-h-[calc(100dvh-4rem)] max-w-7xl overflow-y-auto px-4 pb-8 pt-2" aria-label="Mobile">
            {nav.map((item) => (
              <div key={item.href} className="border-b border-white/5 py-1 light:border-slate-100">
                {item.children ? (
                  <>
                    <p className="px-3 pt-3 text-[10px] font-bold uppercase tracking-widest text-indigo-300/80 light:text-indigo-500">{item.label}</p>
                    {item.children.map((c) => (
                      <Link key={c.href} href={c.href} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-200 hover:bg-white/5 light:text-slate-700 light:hover:bg-slate-100">
                        {c.label}
                      </Link>
                    ))}
                    <Link href="/features" className="block rounded-lg px-3 py-2.5 text-sm font-semibold text-indigo-300 hover:bg-white/5 light:text-indigo-600 light:hover:bg-slate-100">
                      All features →
                    </Link>
                  </>
                ) : (
                  <Link href={item.href} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-200 hover:bg-white/5 light:text-slate-700 light:hover:bg-slate-100">
                    {item.label}
                  </Link>
                )}
              </div>
            ))}
            <div className="mt-4 flex items-center gap-2">
              <Link href={identity.navSignInHref || "/login"} className="flex-1 rounded-lg border border-white/15 px-3 py-2.5 text-center text-sm font-semibold text-white hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100">
                {identity.navSignInLabel || "Sign in"}
              </Link>
              <Link href={identity.navCtaHref || "/register"} className="flex-1 rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-3 py-2.5 text-center text-sm font-semibold text-white">
                {identity.navCtaLabel || "Get Started"}
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  )
}

"use client"
// ============ Public website theme — dark/light toggle + sync ============
// Storage key `site_theme` is deliberately SEPARATE from the HRM app's
// `hrm_theme`: the marketing site and the application are different surfaces
// with independent preferences, and the app may follow a vendor branding
// default post-hydration. The root layout's pre-paint script applies the class
// before first paint (no flash); this module owns toggling and re-syncing
// after client-side navigation into the public group (e.g. arriving from /app
// with the app's theme still on <html>).
import { useEffect, useSyncExternalStore, useState } from "react"
import { Moon, Sun } from "lucide-react"

export type SiteTheme = "dark" | "light"

const KEY = "site_theme"
const listeners = new Set<() => void>()

function readStored(): SiteTheme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === "dark" || v === "light" ? v : null
  } catch {
    return null
  }
}

function systemDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
  } catch {
    return true
  }
}

function writeTheme(next: SiteTheme) {
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* private browsing — preference just won't persist */
  }
  document.documentElement.classList.toggle("dark", next === "dark")
  listeners.forEach((l) => l())
}

/**
 * Re-assert the stored site theme after client-side navigation into the
 * public group. The root pre-paint script only runs on full page loads, so
 * without this an /app → / (client) transition would inherit the app's theme.
 * Renders nothing.
 */
export function SiteThemeSync() {
  useEffect(() => {
    const next = readStored() ?? (systemDark() ? "dark" : "light")
    document.documentElement.classList.toggle("dark", next === "dark")
    // 2026-10-25 design systems — data-design belongs to the WORKSPACE
    // surfaces only (/app, /owner); the pre-paint script strips it on full
    // loads, this covers client-side navigation into the public group (e.g.
    // the owner console's "Public website" link) so the marketing site never
    // inherits a workspace design.
    document.documentElement.removeAttribute("data-design")
  }, [])
  return null
}

/**
 * Sun/Moon toggle for the public chrome. Hydration-safe: the server and the
 * first client render both emit the dark-mode placeholder (the pre-paint
 * script has already applied the right class), then the correct icon appears
 * after mount — no mismatch, no flash.
 */
export function SiteThemeToggle({ className }: { className?: string }) {
  const stored = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => readStored(),
    () => null,
  )
  const [mounted, setMounted] = useState(false)
  // setState INSIDE the rAF callback — asynchronous by construction, so no
  // render can be triggered synchronously from the effect body (matches the
  // header's established pattern for this same lint rule).
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const dark = mounted
    ? (stored ?? (document.documentElement.classList.contains("dark") ? "dark" : "light")) === "dark"
    : true

  return (
    <button
      type="button"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => writeTheme(dark ? "light" : "dark")}
      className={
        className ??
        "rounded-lg p-2 text-slate-300 transition-colors hover:bg-white/5 hover:text-white light:text-slate-600 light:hover:bg-slate-100 light:hover:text-slate-900"
      }
    >
      {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  )
}

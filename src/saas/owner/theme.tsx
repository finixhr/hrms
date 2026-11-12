"use client"
// ============ Owner console theme — dark/light toggle + sync ============
// Storage key `owner_theme` is SEPARATE from the app (`hrm_theme`) and the
// public site (`site_theme`): three surfaces, three independent preferences.
// The root layout's pre-paint script applies the class before first paint
// (owner surfaces DEFAULT DARK); this module owns toggling and re-syncing
// after client-side navigation.
import { useEffect, useSyncExternalStore, useState } from "react"
import { Moon, Sun } from "lucide-react"

export type OwnerTheme = "dark" | "light"

const KEY = "owner_theme"
const listeners = new Set<() => void>()

function readStored(): OwnerTheme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === "dark" || v === "light" ? v : null
  } catch {
    return null
  }
}

function writeTheme(next: OwnerTheme) {
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* private browsing — preference just won't persist */
  }
  document.documentElement.classList.toggle("dark", next === "dark")
  listeners.forEach((l) => l())
}

/** Re-assert the stored owner theme after client-side navigation within the
 *  owner group (the pre-paint script only runs on full page loads). */
export function OwnerThemeSync() {
  useEffect(() => {
    const next = readStored() ?? "dark"
    document.documentElement.classList.toggle("dark", next === "dark")
  }, [])
  return null
}

/** Sun/Moon toggle for the owner surfaces. Hydration-safe: both the server
 *  and the first client render emit the dark-mode placeholder (pre-paint has
 *  already applied the right class), the correct icon appears after mount. */
export function OwnerThemeToggle({ className }: { className?: string }) {
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
  // setState inside the rAF callback — asynchronous by construction (matches
  // the site theme toggle's pattern for the set-state-in-effect lint rule).
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
        "rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/5 hover:text-white light:text-slate-500 light:hover:bg-slate-100 light:hover:text-slate-900"
      }
    >
      {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  )
}

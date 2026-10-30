"use client"
// ============ Platform design systems — Comet / Cursor 1 / Cursor 2 ============
// master prompt Part L §17: three selectable workspace designs. The active
// design is carried by data-design on <html> ("comet" | "cursor-1" |
// "cursor-2"); dark mode stays ORTHOGONAL (html.dark) and keeps working under
// every design. Selection is COSMETIC ONLY — it never gates permissions,
// modules or functionality (all overrides live in src/app/globals.css).
//
// Preferences are per-surface, mirroring the theme keys:
//   · tenant app (/app)     → localStorage "hrm_design"
//   · owner console (/owner) → localStorage "owner_design"
// The pre-paint script (src/lib/prepaint-script.ts) applies the attribute
// before first paint — no flash, no hydration mismatch: React NEVER renders
// data-design, only this module and the pre-paint script write it.
//
// State follows the established external-store pattern (i18n.tsx language
// switcher / app-shell theme toggle): useSyncExternalStore + a module-level
// listener set + the native `storage` event so OTHER open tabs re-sync too.

import { useEffect, useSyncExternalStore } from "react"
import { Check, Palette } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export type Design = "comet" | "cursor-1" | "cursor-2"
export type DesignSurface = "app" | "owner"

const DESIGN_KEYS: Record<DesignSurface, string> = {
  app: "hrm_design",
  owner: "owner_design",
}

/** Anything unrecognized (or absent) resolves to the platform default. */
function normalizeDesign(v: string | null): Design {
  return v === "cursor-1" || v === "cursor-2" ? v : "comet"
}

// ---- external store (mirrors the theme/language switchers) ----
const listeners = new Set<() => void>()
function emit() {
  listeners.forEach((l) => l())
}
function onStorage(e: StorageEvent) {
  // cross-tab sync: the storage event fires in every OTHER tab that shares
  // localStorage — either surface key changing means a re-read is needed
  if (e.key === DESIGN_KEYS.app || e.key === DESIGN_KEYS.owner) emit()
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener("storage", onStorage)
  }
}
function readDesign(surface: DesignSurface): Design {
  try {
    return normalizeDesign(window.localStorage.getItem(DESIGN_KEYS[surface]))
  } catch {
    return "comet"
  }
}

/** Switch the active design for a surface: persists the preference, applies
 *  the html attribute immediately (next frame paints the new design — no
 *  reload), and notifies subscribers. Cosmetic only. */
export function applyDesign(surface: DesignSurface, value: Design) {
  try {
    window.localStorage.setItem(DESIGN_KEYS[surface], value)
  } catch {
    /* private browsing — preference just won't persist */
  }
  document.documentElement.setAttribute("data-design", value)
  emit()
}

/** Hydration-safe hook: the server snapshot is always "comet" (React never
 *  renders the attribute — pre-paint owns it), the client reads the stored
 *  preference after mount, same pattern as useLang()/DarkModeToggle. */
export function useDesign(surface: DesignSurface): Design {
  return useSyncExternalStore(
    subscribe,
    () => readDesign(surface),
    () => "comet" as Design,
  )
}

// ---- switcher UI ----
const DESIGN_META: { value: Design; label: string; hint: string; dot: { size: number; radius: number } }[] = [
  { value: "comet", label: "Comet", hint: "Balanced SaaS workspace", dot: { size: 11, radius: 5 } },
  { value: "cursor-1", label: "Cursor 1", hint: "Dense Mono — compact IDE workbench", dot: { size: 9, radius: 1.5 } },
  { value: "cursor-2", label: "Cursor 2", hint: "Editorial Calm — roomy, softer layout", dot: { size: 13, radius: 7 } },
]

/** Palette-button + popover with the three designs. Tiny dot glyphs preview
 *  each variant's radius/density; Comet carries the "Default" marker.
 *  Works on both surfaces (tenant header + owner console topbar) — it is
 *  styled from shadcn tokens, not surface-specific classes. */
export function DesignSwitcher({ surface }: { surface: DesignSurface }) {
  const active = useDesign(surface)
  // Re-assert after client-side navigation into the surface: the pre-paint
  // script only runs on full page loads (mirrors OwnerThemeSync/SiteThemeSync).
  useEffect(() => {
    document.documentElement.setAttribute("data-design", readDesign(surface))
  }, [surface])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Design system"
          title="Design system"
          className="h-8 w-8 rounded-md hover:bg-accent hover:text-accent-foreground flex items-center justify-center transition-colors hrm-focus"
        >
          <Palette className="h-4 w-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <p className="text-xs font-semibold">Design system</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 mb-2.5">
          Workspace density &amp; geometry — cosmetic only.
        </p>
        <div className="space-y-1" role="group" aria-label="Workspace design">
          {DESIGN_META.map((d) => {
            const on = active === d.value
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => applyDesign(surface, d.value)}
                aria-pressed={on}
                className={cn(
                  "w-full flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors hrm-focus",
                  on ? "border-primary/50 bg-primary/10" : "border-transparent hover:bg-accent",
                )}
              >
                {/* tiny visual dot: radius + density preview of the variant */}
                <span
                  aria-hidden
                  className="shrink-0 bg-primary/75"
                  style={{ width: d.dot.size, height: d.dot.size, borderRadius: d.dot.radius }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold">{d.label}</span>
                    {d.value === "comet" && (
                      <span className="rounded-full bg-muted px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                        Default
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-muted-foreground truncate">{d.hint}</span>
                </span>
                {on && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
              </button>
            )
          })}
        </div>
        <p className="mt-2.5 border-t pt-2 text-[10.5px] text-muted-foreground">
          Comet is the platform default design.
        </p>
      </PopoverContent>
    </Popover>
  )
}

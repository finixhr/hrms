"use client"
// ============ Widget dashboard — shared types ============
// The customizable dashboard is built from a registry of widget definitions.
// Every widget declares its OWN availability gates (permission, module
// visibility, SaaS feature, role) plus sizing hints, so the grid and the
// picker can filter what a given user may see without any per-screen logic.
//
// 2026-10 expansion — widgets can now span multiple GRID ROWS as well as
// columns (rowSpan), feed-style widgets (live attendance, approvals queue)
// default to 2 rows so tall content finally gets the room it needs.

/** Grid spans out of 12 columns. */
export type WidgetSize = 3 | 4 | 6 | 8 | 12
export const WIDGET_SIZES: WidgetSize[] = [3, 4, 6, 8, 12]

/** Row span in grid row units (1 = single row, the previous behavior). */
export type WidgetRowSpan = 1 | 2 | 3
export const WIDGET_ROW_SPANS: WidgetRowSpan[] = [1, 2, 3]

/** Runtime context handed to every widget render fn. */
export type WidgetCtx = {
  /** The dashboard.stats payload (already loaded by the view). */
  data: any
  navigate: (key: string, params?: Record<string, unknown>) => void
  can: (module: string, action: string) => boolean
}

export type WidgetCategory =
  | "Overview"
  | "People"
  | "Time & Attendance"
  | "Payroll & Finance"
  | "Compliance & Alerts"
  | "Communication"
  | "Operations"
  | "Platform"

export type WidgetDef = {
  id: string
  title: string
  icon: any
  description: string
  category: WidgetCategory
  /** Preferred span out of 12. */
  defaultSize: WidgetSize
  /** Minimum span (resize clamps to this). */
  minSize?: WidgetSize
  /** Preferred row span (feed-style widgets default to 2). */
  defaultRowSpan?: WidgetRowSpan
  /** Minimum row span (vertical resize clamps to this). */
  minRowSpan?: WidgetRowSpan
  /** Optional module link rendered as a header "View" affordance. */
  linkTo?: string
  /** Action permission gate — can(module, action). */
  perm?: [string, string]
  /** Module visibility gate — hidden modules (Settings → Modules). */
  module?: string
  /** SaaS subscription feature gate (entitlements mirror). */
  feature?: string
  /** Restrict to specific roles. */
  roles?: string[]
  /** Extra classes for the widget body wrapper (charts go edge-to-edge). */
  bodyClassName?: string
  render: (ctx: WidgetCtx) => React.ReactNode
}

/** A widget placed on the user's dashboard. */
export type PlacedWidget = { id: string; size: WidgetSize; rowSpan?: WidgetRowSpan }
export type DashboardLayout = { widgets: PlacedWidget[] }

/** Availability inputs resolved once by the grid. */
export type WidgetGates = {
  can: (module: string, action: string) => boolean
  hiddenModules: Set<string>
  subscription: {
    mode: "SUBSCRIBED" | "LEGACY"
    features: Record<string, boolean> | null
    /** Per-tenant module overrides from the SaaS Owner Console. */
    overrides?: Record<string, boolean> | null
  } | null
  role: string
}

/** True when the user may see/use the widget at all. Mirrors the same rules
 *  the sidebar uses (permission + disabled modules + SaaS entitlements). */
export function isWidgetAvailable(def: WidgetDef, gates: WidgetGates): boolean {
  if (def.roles && !def.roles.includes(gates.role)) return false
  if (def.perm && !gates.can(def.perm[0], def.perm[1])) return false
  if (def.module && gates.hiddenModules.has(def.module)) return false
  // 2026-10 module-consistency round — an explicit per-tenant override wins
  // for ANY module (mirrors the server's featureBlocked() precedence)
  if (def.module && gates.subscription?.overrides && typeof gates.subscription.overrides[def.module] === "boolean") {
    if (gates.subscription.overrides[def.module] === false) return false
  }
  if (
    def.feature &&
    gates.subscription?.mode === "SUBSCRIBED" &&
    gates.subscription.features &&
    gates.subscription.features[def.feature] === false
  ) return false
  return true
}

/** Responsive span mapping. The grid is always 12 columns wide; on smaller
 *  screens spans collapse so nothing gets unreadably narrow:
 *  - >= 1280px (xl): exact saved span
 *  - 768–1279px (md/lg): narrow widgets take a half row (6), wide stay full
 *  - < 768px (mobile): everything stacks full-width */
export function effectiveSpan(size: WidgetSize, cols: 12 | 6 | 1): number {
  if (cols === 12) return size
  if (cols === 1) return 12
  return size <= 6 ? 6 : 12
}

/** Responsive row-span mapping: row spanning only makes sense on the full
 *  12-column desktop grid; tablet/mobile stack everything to single rows. */
export function effectiveRowSpan(rowSpan: number | undefined, cols: 12 | 6 | 1): number {
  if (cols !== 12) return 1
  const r = rowSpan ?? 1
  return r >= 3 ? 3 : r >= 2 ? 2 : 1
}

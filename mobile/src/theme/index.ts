// Design system — colours, typography, spacing, shadows
// Import from here everywhere to keep the UI consistent

import { StyleSheet, Platform } from "react-native";

// ── Brand palette ──────────────────────────────────────────────────────────
export const Colors = {
  // Primary — deep indigo/blue
  primary:        "#4F46E5",   // indigo-600
  primaryLight:   "#EEF2FF",   // indigo-50
  primaryDark:    "#3730A3",   // indigo-800
  primaryText:    "#FFFFFF",

  // Accent — violet/purple for highlights
  accent:         "#7C3AED",   // violet-600
  accentLight:    "#F5F3FF",   // violet-50

  // Semantic
  success:        "#10B981",   // emerald-500
  successLight:   "#D1FAE5",
  warning:        "#F59E0B",   // amber-500
  warningLight:   "#FEF3C7",
  danger:         "#EF4444",   // red-500
  dangerLight:    "#FEE2E2",
  info:           "#06B6D4",   // cyan-500
  infoLight:      "#CFFAFE",

  // Neutrals
  surface:        "#FFFFFF",
  surfaceAlt:     "#F8FAFC",
  background:     "#F1F5F9",   // slate-100
  border:         "#E2E8F0",   // slate-200
  borderLight:    "#F1F5F9",

  // Text
  textPrimary:    "#0F172A",   // slate-900
  textSecondary:  "#475569",   // slate-600
  textTertiary:   "#94A3B8",   // slate-400
  textInverse:    "#FFFFFF",

  // Status chips
  statusActive:   "#10B981",
  statusInactive: "#6B7280",
  statusPending:  "#F59E0B",
  statusApproved: "#10B981",
  statusRejected: "#EF4444",
} as const;

// ── Typography scale ───────────────────────────────────────────────────────
export const Typography = StyleSheet.create({
  display: { fontSize: 32, fontWeight: "800", color: Colors.textPrimary, letterSpacing: -0.5 },
  h1:      { fontSize: 26, fontWeight: "700", color: Colors.textPrimary, letterSpacing: -0.3 },
  h2:      { fontSize: 20, fontWeight: "700", color: Colors.textPrimary },
  h3:      { fontSize: 17, fontWeight: "600", color: Colors.textPrimary },
  h4:      { fontSize: 15, fontWeight: "600", color: Colors.textPrimary },
  body:    { fontSize: 15, fontWeight: "400", color: Colors.textSecondary, lineHeight: 22 },
  bodyS:   { fontSize: 13, fontWeight: "400", color: Colors.textSecondary, lineHeight: 20 },
  caption: { fontSize: 11, fontWeight: "500", color: Colors.textTertiary, letterSpacing: 0.5 },
  label:   { fontSize: 12, fontWeight: "600", color: Colors.textSecondary, letterSpacing: 0.4 },
  mono:    { fontSize: 13, fontWeight: "500", fontVariant: ["tabular-nums"] as any, color: Colors.textPrimary },
});

// ── Spacing ────────────────────────────────────────────────────────────────
export const Spacing = {
  xs:  4,
  sm:  8,
  md:  12,
  lg:  16,
  xl:  24,
  xxl: 32,
} as const;

// ── Radius ─────────────────────────────────────────────────────────────────
export const Radius = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   20,
  full: 999,
} as const;

// ── Shadows ────────────────────────────────────────────────────────────────
export const Shadow = {
  sm: Platform.select({
    ios:     { shadowColor: "#0F172A", shadowOpacity: 0.06, shadowRadius: 6,  shadowOffset: { width: 0, height: 2 } },
    android: { elevation: 2 },
  }),
  md: Platform.select({
    ios:     { shadowColor: "#0F172A", shadowOpacity: 0.09, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
    android: { elevation: 4 },
  }),
  lg: Platform.select({
    ios:     { shadowColor: "#0F172A", shadowOpacity: 0.13, shadowRadius: 20, shadowOffset: { width: 0, height: 6 } },
    android: { elevation: 8 },
  }),
} as const;

// ── Module colour map (for module cards) ──────────────────────────────────
export const ModuleColors: Record<string, string> = {
  attendance:   "#4F46E5",
  leave:        "#10B981",
  payroll:      "#F59E0B",
  performance:  "#7C3AED",
  recruitment:  "#06B6D4",
  training:     "#F97316",
  assets:       "#64748B",
  finance:      "#EF4444",
  fieldforce:   "#0EA5E9",
  accounting:   "#8B5CF6",
  ess:          "#EC4899",
  reports:      "#14B8A6",
  onboarding:   "#A855F7",
  letters:      "#6366F1",
  procurement:  "#D97706",
  inventory:    "#059669",
  tracking:     "#DC2626",
  support:      "#2563EB",
};

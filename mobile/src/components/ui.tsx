// Reusable UI components — Button, Card, Badge, Avatar, Input, EmptyState, Skeleton

import React from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
<<<<<<< HEAD
  ViewStyle,
=======
  StyleSheet,
  ViewStyle,
  TextStyle,
>>>>>>> origin/main
  TextInputProps,
  StyleProp,
  DimensionValue,
} from "react-native";
import { Colors, Typography, Spacing, Radius, Shadow } from "../theme";

// ── Button ─────────────────────────────────────────────────────────────────
interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "success";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

const btnVariant = {
  primary:   { bg: Colors.primary,   text: "#fff", border: Colors.primary   },
  secondary: { bg: Colors.primaryLight, text: Colors.primary, border: Colors.primary },
  danger:    { bg: Colors.danger,    text: "#fff", border: Colors.danger     },
  ghost:     { bg: "transparent",    text: Colors.textSecondary, border: Colors.border },
  success:   { bg: Colors.success,   text: "#fff", border: Colors.success    },
};
const btnSize = {
  sm: { py: 8,  px: 14, fontSize: 13, radius: Radius.sm },
  md: { py: 13, px: 20, fontSize: 15, radius: Radius.md },
  lg: { py: 16, px: 26, fontSize: 16, radius: Radius.md },
};

export function Button({ label, onPress, variant = "primary", size = "md", loading, disabled, icon, fullWidth, style }: ButtonProps) {
  const v = btnVariant[variant];
  const s = btnSize[size];
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.78}
      style={[
        { backgroundColor: v.bg, borderWidth: 1.5, borderColor: v.border, borderRadius: s.radius,
          paddingVertical: s.py, paddingHorizontal: s.px, flexDirection: "row", alignItems: "center",
          justifyContent: "center", opacity: (disabled || loading) ? 0.55 : 1 },
        fullWidth && { width: "100%" },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.text} size="small" />
      ) : (
        <>
          {icon && <View style={{ marginRight: 6 }}>{icon}</View>}
          <Text style={{ color: v.text, fontWeight: "600", fontSize: s.fontSize }}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────
interface CardProps { children: React.ReactNode; style?: StyleProp<ViewStyle>; padding?: number; onPress?: () => void }
export function Card({ children, style, padding = Spacing.lg, onPress }: CardProps) {
  if (onPress) {
    return (
      <TouchableOpacity activeOpacity={0.82} onPress={onPress}
        style={[{ backgroundColor: Colors.surface, borderRadius: Radius.lg, padding, ...Shadow.sm }, style]}>
        {children}
      </TouchableOpacity>
    );
  }
  return (
    <View style={[{ backgroundColor: Colors.surface, borderRadius: Radius.lg, padding, ...Shadow.sm }, style]}>
      {children}
    </View>
  );
}

// ── Badge ──────────────────────────────────────────────────────────────────
const statusColor: Record<string, { bg: string; text: string }> = {
  ACTIVE:    { bg: Colors.successLight, text: Colors.success },
  APPROVED:  { bg: Colors.successLight, text: Colors.success },
  PENDING:   { bg: Colors.warningLight, text: Colors.warning },
  REJECTED:  { bg: Colors.dangerLight,  text: Colors.danger  },
  CANCELLED: { bg: "#F1F5F9",           text: Colors.textTertiary },
  INACTIVE:  { bg: "#F1F5F9",           text: Colors.textTertiary },
  PRESENT:   { bg: Colors.successLight, text: Colors.success },
  ABSENT:    { bg: Colors.dangerLight,  text: Colors.danger  },
  LATE:      { bg: Colors.warningLight, text: Colors.warning },
  HOLIDAY:   { bg: Colors.infoLight,    text: Colors.info    },
};
interface BadgeProps { label: string; style?: StyleProp<ViewStyle> }
export function Badge({ label, style }: BadgeProps) {
  const c = statusColor[label.toUpperCase()] ?? { bg: Colors.primaryLight, text: Colors.primary };
  return (
    <View style={[{ backgroundColor: c.bg, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 }, style]}>
      <Text style={{ color: c.text, fontSize: 11, fontWeight: "700", letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}

// ── Avatar ─────────────────────────────────────────────────────────────────
const avatarColors = ["#4F46E5","#7C3AED","#10B981","#F59E0B","#06B6D4","#EC4899","#EF4444","#F97316"];
function avatarColor(name: string) { return avatarColors[name.charCodeAt(0) % avatarColors.length]; }
interface AvatarProps { name: string; size?: number; style?: StyleProp<ViewStyle> }
export function Avatar({ name, size = 40, style }: AvatarProps) {
  const initials = name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: avatarColor(name),
      justifyContent: "center", alignItems: "center" }, style]}>
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: size * 0.36 }}>{initials}</Text>
    </View>
  );
}

// ── Input ──────────────────────────────────────────────────────────────────
interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}
export function Input({ label, error, leftIcon, style, ...props }: InputProps) {
  return (
    <View style={[{ gap: 4 }, style]}>
      {label && <Text style={[Typography.label, { marginBottom: 2 }]}>{label}</Text>}
      <View style={{
        flexDirection: "row", alignItems: "center",
        borderWidth: 1.5, borderColor: error ? Colors.danger : Colors.border,
        borderRadius: Radius.md, backgroundColor: Colors.surfaceAlt,
        paddingHorizontal: Spacing.md,
      }}>
        {leftIcon && <View style={{ marginRight: 8 }}>{leftIcon}</View>}
        <TextInput
          placeholderTextColor={Colors.textTertiary}
          style={{ flex: 1, paddingVertical: 13, fontSize: 15, color: Colors.textPrimary }}
          {...props}
        />
      </View>
      {error && <Text style={{ color: Colors.danger, fontSize: 12 }}>{error}</Text>}
    </View>
  );
}

// ── Section header ─────────────────────────────────────────────────────────
interface SectionProps { title: string; action?: string; onAction?: () => void; style?: StyleProp<ViewStyle> }
export function SectionHeader({ title, action, onAction, style }: SectionProps) {
  return (
    <View style={[{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, style]}>
      <Text style={Typography.h3}>{title}</Text>
      {action && <TouchableOpacity onPress={onAction}><Text style={{ color: Colors.primary, fontWeight: "600", fontSize: 13 }}>{action}</Text></TouchableOpacity>}
    </View>
  );
}

// ── Empty state ────────────────────────────────────────────────────
interface EmptyProps { icon?: string; title: string; subtitle?: string }
export function EmptyState({ icon = "📭", title, subtitle }: EmptyProps) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 48, gap: 8 }}>
      <Text style={{ fontSize: 40 }}>{icon}</Text>
      <Text style={[Typography.h4, { textAlign: "center" }]}>{title}</Text>
      {subtitle && <Text style={[Typography.bodyS, { textAlign: "center" }]}>{subtitle}</Text>}
    </View>
  );
}

// ── Skeleton loader ────────────────────────────────────────────────────────
export function SkeletonBlock({ width, height = 16, style }: { width?: DimensionValue; height?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ height, backgroundColor: Colors.border, borderRadius: Radius.sm, width: width ?? "100%" }, style]} />
  );
}

// ── Stat chip ──────────────────────────────────────────────────────────────
interface StatChipProps { value: number | string; label: string; color?: string; style?: StyleProp<ViewStyle> }
export function StatChip({ value, label, color = Colors.primary, style }: StatChipProps) {
  return (
    <View style={[{ backgroundColor: color + "15", borderRadius: Radius.lg, padding: Spacing.md, alignItems: "center", flex: 1 }, style]}>
      <Text style={{ fontSize: 26, fontWeight: "800", color }}>{value}</Text>
      <Text style={[Typography.caption, { marginTop: 2, textAlign: "center" }]}>{label}</Text>
    </View>
  );
}

// ── Row item (list rows) ───────────────────────────────────────────────────
interface RowItemProps {
  title: string;
  subtitle?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}
export function RowItem({ title, subtitle, left, right, onPress, style }: RowItemProps) {
  const Inner = (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: Spacing.md }, style]}>
      {left}
      <View style={{ flex: 1 }}>
        <Text style={Typography.h4} numberOfLines={1}>{title}</Text>
        {subtitle && <Text style={[Typography.bodyS, { marginTop: 1 }]} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );
  return onPress ? (
    <TouchableOpacity activeOpacity={0.75} onPress={onPress}>{Inner}</TouchableOpacity>
  ) : Inner;
}

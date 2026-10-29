// Profile / Me screen — polished user card + settings + sign-out

import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, StatusBar, Alert, Switch,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "@/src/lib/auth";
import { Avatar, Card, Button } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";
import { useState } from "react";

interface SettingRow {
  icon: string;
  label: string;
  sub?: string;
  toggle?: boolean;
  onPress?: () => void;
  danger?: boolean;
  chevron?: boolean;
}

function SettingSection({ title, rows }: { title: string; rows: SettingRow[] }) {
  const [switches, setSwitches] = useState<Record<string, boolean>>({});
  return (
    <View style={{ gap: 0 }}>
      <Text style={[Typography.label, { marginBottom: 8, paddingHorizontal: 4 }]}>{title}</Text>
      <Card padding={0}>
        {rows.map((r, i) => (
          <TouchableOpacity
            key={r.label}
            disabled={r.toggle}
            onPress={r.onPress}
            activeOpacity={0.72}
            style={[
              styles.settingRow,
              i > 0 && { borderTopWidth: 1, borderTopColor: Colors.borderLight },
            ]}
          >
            <View style={[styles.settingIcon, { backgroundColor: r.danger ? Colors.dangerLight : Colors.primaryLight }]}>
              <Ionicons name={r.icon as any} size={18} color={r.danger ? Colors.danger : Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[Typography.h4, r.danger && { color: Colors.danger }]}>{r.label}</Text>
              {r.sub && <Text style={[Typography.bodyS, { marginTop: 1 }]}>{r.sub}</Text>}
            </View>
            {r.toggle ? (
              <Switch
                value={switches[r.label] ?? false}
                onValueChange={v => setSwitches(s => ({ ...s, [r.label]: v }))}
                trackColor={{ true: Colors.primary }}
              />
            ) : r.chevron !== false ? (
              <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
            ) : null}
          </TouchableOpacity>
        ))}
      </Card>
    </View>
  );
}

export default function ProfileScreen() {
  const { user, logout, isLoading } = useAuthStore();

  const handleLogout = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => logout() },
    ]);
  };

  if (!user) return null;

  const accountRows: SettingRow[] = [
    { icon: "person-outline",      label: "Edit Profile",       sub: "Update your information",   chevron: true },
    { icon: "lock-closed-outline", label: "Change Password",    sub: "Update security credentials", chevron: true },
    { icon: "shield-outline",      label: "Two-Factor Auth",    sub: "Manage MFA settings",        chevron: true },
    { icon: "finger-print",        label: "Biometrics",         sub: "Face ID / fingerprint login", toggle: true   },
  ];
  const notifRows: SettingRow[] = [
    { icon: "notifications-outline", label: "Push Notifications", toggle: true },
    { icon: "mail-outline",          label: "Email Alerts",       toggle: true },
  ];
  const appRows: SettingRow[] = [
    { icon: "moon-outline",    label: "Dark Mode",     toggle: true },
    { icon: "language",        label: "Language",      sub: "English",       chevron: true },
    { icon: "help-circle-outline", label: "Help & Support", chevron: true },
    { icon: "information-circle-outline", label: "About Finix HR", sub: "v1.0.0", chevron: true },
  ];
  const dangerRows: SettingRow[] = [
    { icon: "log-out-outline", label: "Sign Out", danger: true, chevron: false, onPress: handleLogout },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: Colors.background }} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <LinearGradient colors={["#0F172A", "#1E293B"]} style={styles.header}>
        <View style={{ alignItems: "center", gap: Spacing.md }}>
          <View style={{ position: "relative" }}>
            <Avatar name={user.name} size={84} style={{ borderWidth: 3, borderColor: Colors.primary }} />
            <TouchableOpacity style={styles.editBadge}>
              <Ionicons name="camera" size={14} color="#fff" />
            </TouchableOpacity>
          </View>
          <View style={{ alignItems: "center" }}>
            <Text style={styles.name}>{user.name}</Text>
            <Text style={styles.email}>{user.email}</Text>
            <View style={[styles.rolePill]}>
              <Text style={styles.roleText}>{user.role}</Text>
            </View>
          </View>
        </View>
      </LinearGradient>

      {/* Info chips */}
      <View style={styles.infoRow}>
        <View style={styles.infoChip}>
          <Ionicons name="business-outline" size={14} color={Colors.primary} />
          <Text style={[Typography.caption, { color: Colors.primary }]}>Vendor ID</Text>
          <Text style={[Typography.label, { color: Colors.primary }]}>{user.vendorId.slice(0, 8)}…</Text>
        </View>
        <View style={styles.infoChip}>
          <Ionicons name="id-card-outline" size={14} color={Colors.accent} />
          <Text style={[Typography.caption, { color: Colors.accent }]}>User ID</Text>
          <Text style={[Typography.label, { color: Colors.accent }]}>{user.id.slice(0, 8)}…</Text>
        </View>
      </View>

      <View style={{ padding: Spacing.lg, gap: Spacing.xl }}>
        <SettingSection title="ACCOUNT"       rows={accountRows} />
        <SettingSection title="NOTIFICATIONS" rows={notifRows}   />
        <SettingSection title="APP"           rows={appRows}     />
        <SettingSection title="DANGER ZONE"   rows={dangerRows}  />
        <Text style={[Typography.caption, { textAlign: "center" }]}>Finix HR Mobile · v1.0.0 · Secured end-to-end</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: Platform.OS === "ios" ? 60 : (StatusBar.currentHeight ?? 0) + 16,
    paddingBottom: Spacing.xl + 24,
    paddingHorizontal: Spacing.xl,
    alignItems: "center",
  },
  name:  { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: 4 },
  email: { color: "rgba(255,255,255,0.65)", fontSize: 13, marginTop: 2 },
  rolePill: {
    marginTop: 8, backgroundColor: Colors.primary,
    paddingHorizontal: 14, paddingVertical: 5, borderRadius: Radius.full,
  },
  roleText: { color: "#fff", fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  editBadge: {
    position: "absolute", bottom: 0, right: 0,
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: Colors.primary, justifyContent: "center", alignItems: "center",
    borderWidth: 2, borderColor: Colors.surface,
  },
  infoRow: {
    flexDirection: "row", gap: Spacing.md,
    padding: Spacing.lg, paddingTop: Spacing.xl,
    marginTop: -20,
  },
  infoChip: {
    flex: 1, backgroundColor: Colors.surface,
    borderRadius: Radius.lg, padding: Spacing.md,
    alignItems: "center", gap: 3,
    ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }, android: { elevation: 2 } }),
  },
  settingRow: {
    flexDirection: "row", alignItems: "center",
    padding: Spacing.lg, gap: Spacing.md,
  },
  settingIcon: {
    width: 36, height: 36, borderRadius: 10,
    justifyContent: "center", alignItems: "center",
  },
});

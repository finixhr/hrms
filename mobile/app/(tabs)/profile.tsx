// Profile / Me screen — polished user card + settings + sign-out
//
// FIN-008 (Phase 1) — mobile honesty: this screen used to ship four LOCAL-
// STATE-ONLY toggles (Biometrics, Push Notifications, Email Alerts, Dark
// Mode) that flipped a React switch and persisted NOTHING — controls that
// promise what they do not do. They are gone. Every remaining row either
// goes somewhere real (the native ESS / Support screens, the web portal
// launcher) or states a fact. The "Secured end-to-end" footer claim is gone
// too: the app is TLS-transport-secured, which is not end-to-end encryption.

import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, StatusBar, Alert,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import { useAuthStore } from "@/src/lib/auth";
import { getBaseUrl } from "@/src/lib/api";
import { Avatar, Card } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface SettingRow {
  icon: string;
  label: string;
  sub?: string;
  onPress?: () => void;
  danger?: boolean;
}

function SettingSection({ title, rows }: { title: string; rows: SettingRow[] }) {
  return (
    <View style={{ gap: 0 }}>
      <Text style={[Typography.label, { marginBottom: 8, paddingHorizontal: 4 }]}>{title}</Text>
      <Card padding={0}>
        {rows.map((r, i) => (
          <TouchableOpacity
            key={r.label}
            disabled={!r.onPress}
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
            {r.onPress ? (
              <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
            ) : null}
          </TouchableOpacity>
        ))}
      </Card>
    </View>
  );
}

export default function ProfileScreen() {
  const { user, logout } = useAuthStore();
  const router = useRouter();

  const handleLogout = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => logout() },
    ]);
  };

  // FIN-008 — every row below is either wired to a real destination or
  // states a fact. Password / MFA management lives in the web portal's HR
  // Settings; the app opens it with the same launcher pattern the module
  // cards use (/app with a view deep link — FIN-007).
  const openWebPortal = (view?: string) => {
    const url = `${getBaseUrl()}/app${view ? `?view=${view}` : ""}`;
    Linking.openURL(url).catch(() => {});
  };

  if (!user) return null;

  const accountRows: SettingRow[] = [
    { icon: "person-circle-outline", label: "Self Service", sub: "Announcements, documents, reimbursements", onPress: () => router.push("/(modules)/ess") },
    { icon: "lock-closed-outline", label: "Change Password", sub: "Opens in the web portal", onPress: () => openWebPortal("settings") },
    { icon: "shield-outline",       label: "Two-Factor Auth", sub: "Opens in the web portal", onPress: () => openWebPortal("settings") },
  ];
  const notifRows: SettingRow[] = [
    // FIN-008 — push registration is automatic at sign-in (app/_layout.tsx);
    // e-mail alert preferences are a per-user server setting managed in the
    // web portal. No toggle is shown because no toggle is backed by behavior.
    { icon: "notifications-outline", label: "Push Notifications", sub: "Enabled automatically for this device at sign-in" },
    { icon: "mail-outline",          label: "E-mail Alerts", sub: "Manage per-user preferences in the web portal", onPress: () => openWebPortal("settings") },
  ];
  const appRows: SettingRow[] = [
    { icon: "help-circle-outline", label: "Help & Support", sub: "Tickets and live support requests", onPress: () => router.push("/(modules)/support") },
    { icon: "information-circle-outline", label: "About Finix HR", sub: "v1.0.0" },
  ];
  const dangerRows: SettingRow[] = [
    { icon: "log-out-outline", label: "Sign Out", danger: true, onPress: handleLogout },
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
          <Text style={[Typography.label, { color: Colors.primary }]}>{(user.vendorId ?? "—").slice(0, 8)}…</Text>
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
        <Text style={[Typography.caption, { textAlign: "center" }]}>Finix HR Mobile · v1.0.0 · API secured with TLS</Text>
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

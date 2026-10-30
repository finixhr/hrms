// Generic module screen — for modules not yet implemented natively.
//
// 2026-10-30 fix: this screen used to load the module's web page in a WebView
// with the Bearer token attached to the DOCUMENT request only. The web SPA
// authenticates with session cookies, so its in-page RPC calls always hit 401,
// the SPA redirected to /login, and the old code reacted to that redirect by
// CLEARING the app session token — opening any HR module logged the user out
// of the app. The webview could never authenticate in the first place.
//
// Honest behavior now: this is a launcher — it opens the module in the system
// browser (where the user signs in with their normal web session). Native
// screens exist for the employee-plane modules; this fallback is for the
// long-tail HR/admin modules until they gain native screens.

import { useLocalSearchParams, useRouter } from "expo-router";
import { View, Text, StyleSheet, Platform, StatusBar, TouchableOpacity } from "react-native";
import * as Linking from "expo-linking";
import { getBaseUrl } from "@/src/lib/api";
import { Colors, Typography, Spacing, Radius } from "@/src/theme";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

const MODULE_META: Record<string, { title: string; icon: string; path: string; gradient: [string, string] }> = {
  employees:       { title: "Employees",      icon: "people",         path: "/employees",       gradient: ["#4F46E5","#6366F1"] },
  onboarding:      { title: "Onboarding",     icon: "person-add",     path: "/onboarding",      gradient: ["#7C3AED","#8B5CF6"] },
  exit:            { title: "Exit",           icon: "person-remove",  path: "/exit",            gradient: ["#6B7280","#9CA3AF"] },
  recruitment:     { title: "Recruitment",    icon: "briefcase",      path: "/recruitment",     gradient: ["#06B6D4","#0EA5E9"] },
  rosters:         { title: "Rosters",        icon: "calendar-number",path: "/rosters",         gradient: ["#F59E0B","#D97706"] },
  tracking:        { title: "Live Tracking",  icon: "map",            path: "/tracking",        gradient: ["#DC2626","#EF4444"] },
  fieldforce:      { title: "Field Force",    icon: "navigate",       path: "/fieldforce",       gradient: ["#0EA5E9","#06B6D4"] },
  payroll:         { title: "Payroll",        icon: "cash",           path: "/payroll",         gradient: ["#F59E0B","#F97316"] },
  ait:             { title: "Tax (AIT)",      icon: "calculator",     path: "/ait",             gradient: ["#8B5CF6","#7C3AED"] },
  pf:              { title: "Provident Fund", icon: "wallet",         path: "/pf",              gradient: ["#10B981","#059669"] },
  finance:         { title: "Finance",        icon: "trending-up",    path: "/finance",         gradient: ["#EF4444","#DC2626"] },
  accounting:      { title: "Accounting",     icon: "stats-chart",    path: "/accounting",      gradient: ["#6366F1","#4F46E5"] },
  commissions:     { title: "Commissions",    icon: "ribbon",         path: "/commissions",      gradient: ["#F97316","#EA580C"] },
  payout:          { title: "Payout",         icon: "send",           path: "/payout",           gradient: ["#14B8A6","#0D9488"] },
  ess:             { title: "Self Service",   icon: "person-circle",  path: "/ess",              gradient: ["#EC4899","#DB2777"] },
  letters:         { title: "Letters",        icon: "document-text",  path: "/letters",          gradient: ["#6366F1","#4F46E5"] },
  reimbursements:  { title: "Reimbursements", icon: "receipt",        path: "/reimbursements",  gradient: ["#A855F7","#9333EA"] },
  performance:     { title: "Performance",    icon: "trophy",         path: "/performance",     gradient: ["#7C3AED","#6D28D9"] },
  assets:          { title: "Assets",         icon: "cube",           path: "/assets",           gradient: ["#64748B","#475569"] },
  inventory:       { title: "Inventory",      icon: "layers",         path: "/inventory",        gradient: ["#059669","#10B981"] },
  procurement:     { title: "Procurement",    icon: "cart",           path: "/procurement",      gradient: ["#D97706","#B45309"] },
  cameras:         { title: "Cameras",        icon: "videocam",       path: "/cameras",          gradient: ["#1D4ED8","#2563EB"] },
  communication:   { title: "Communication",  icon: "megaphone",      path: "/communication",   gradient: ["#EC4899","#BE185D"] },
  support:         { title: "Support",        icon: "chatbubbles",    path: "/support",          gradient: ["#2563EB","#1D4ED8"] },
  reports:         { title: "Reports",        icon: "bar-chart",      path: "/reports",          gradient: ["#14B8A6","#0891B2"] },
  ai:              { title: "AI Assist",      icon: "sparkles",       path: "/ai",               gradient: ["#7C3AED","#5B21B6"] },
  organization:    { title: "Organisation",   icon: "git-merge",      path: "/organization",     gradient: ["#0F766E","#0D9488"] },
  integrations:    { title: "Integrations",   icon: "git-branch",     path: "/integrations",    gradient: ["#374151","#1F2937"] },
};

export default function ModuleDetailScreen() {
  const router = useRouter();
  const { module: moduleName } = useLocalSearchParams<{ module: string }>();
  const meta = MODULE_META[moduleName ?? ""] ?? { title: moduleName, icon: "apps", path: "/", gradient: ["#4F46E5","#7C3AED"] as [string, string] };

  const url = `${getBaseUrl()}${meta.path}`;

  const openInBrowser = () => {
    Linking.openURL(url).catch(() => {
      // No handler for the URL on this device — show nothing fake; the info
      // card below already explains the web-portal workflow.
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.background }}>
      <LinearGradient colors={meta.gradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Ionicons name={meta.icon as any} size={20} color="rgba(255,255,255,0.85)" />
        <Text style={styles.title} numberOfLines={1}>{meta.title}</Text>
      </LinearGradient>

      <View style={styles.body}>
        <View style={styles.infoCard}>
          <View style={styles.infoIcon}>
            <Ionicons name="globe-outline" size={28} color={Colors.primary} />
          </View>
          <Text style={Typography.h3} >{meta.title} — Web Portal</Text>
          <Text style={[Typography.body, { marginTop: Spacing.sm, textAlign: "center" }]}>
            This module opens in the Finix HR web portal. Sign in there with your
            account to manage it — your mobile session stays active here.
          </Text>
          <TouchableOpacity style={styles.openBtn} onPress={openInBrowser} activeOpacity={0.85}>
            <Ionicons name="open-outline" size={18} color="#fff" />
            <Text style={styles.openBtnText}>Open in Web Portal</Text>
          </TouchableOpacity>
          <Text style={[Typography.caption, { marginTop: Spacing.md }]}>
            {url.replace(/^https?:\/\//, "")}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    paddingTop: Platform.OS === "ios" ? 60 : (StatusBar.currentHeight ?? 0) + 16,
    paddingBottom: Spacing.md, paddingHorizontal: Spacing.md,
  },
  backBtn: { padding: 4, marginRight: 4 },
  title:   { color: "#fff", fontSize: 18, fontWeight: "700", flex: 1 },
  body:    { flex: 1, padding: Spacing.xl, justifyContent: "center" },
  infoCard: {
    backgroundColor: Colors.surface, borderRadius: Radius.lg,
    padding: Spacing.xl, alignItems: "center", gap: Spacing.sm,
    ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }, android: { elevation: 3 } }),
  },
  infoIcon: {
    width: 60, height: 60, borderRadius: 18,
    backgroundColor: Colors.primaryLight,
    justifyContent: "center", alignItems: "center", marginBottom: Spacing.sm,
  },
  openBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
    marginTop: Spacing.lg,
  },
  openBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});

// Generic module fallback screen — used for modules not yet implemented as native screens
// Shows a web-based view of the module via a WebView pointed at the Next.js app

import { useLocalSearchParams, useRouter } from "expo-router";
import { View, Text, StyleSheet, Platform, StatusBar, TouchableOpacity, BackHandler } from "react-native";
import * as Linking from "expo-linking";
import { WebView } from "react-native-webview";
import { getToken, getBaseUrl, clearToken } from "@/src/lib/api";
import { Colors, Typography, Spacing } from "@/src/theme";
import { Ionicons } from "@expo/vector-icons";
import { useState, useEffect, useRef } from "react";
import { LinearGradient } from "expo-linear-gradient";

const MODULE_META: Record<string, { title: string; icon: string; path: string; gradient: [string, string] }> = {
  employees:       { title: "Employees",      icon: "people",         path: "/employees",       gradient: ["#4F46E5","#6366F1"] },
  onboarding:      { title: "Onboarding",     icon: "person-add",     path: "/onboarding",      gradient: ["#7C3AED","#8B5CF6"] },
  exit:            { title: "Exit",           icon: "person-remove",  path: "/exit",            gradient: ["#6B7280","#9CA3AF"] },
  recruitment:     { title: "Recruitment",    icon: "briefcase",      path: "/recruitment",     gradient: ["#06B6D4","#0EA5E9"] },
  rosters:         { title: "Rosters",        icon: "calendar-number",path: "/rosters",         gradient: ["#F59E0B","#D97706"] },
  tracking:        { title: "Live Tracking",  icon: "map",            path: "/tracking",        gradient: ["#DC2626","#EF4444"] },
  fieldforce:      { title: "Field Force",    icon: "navigate",       path: "/fieldforce",      gradient: ["#0EA5E9","#06B6D4"] },
  payroll:         { title: "Payroll",        icon: "cash",           path: "/payroll",         gradient: ["#F59E0B","#F97316"] },
  ait:             { title: "Tax (AIT)",      icon: "calculator",     path: "/ait",             gradient: ["#8B5CF6","#7C3AED"] },
  pf:              { title: "Provident Fund", icon: "wallet",         path: "/pf",              gradient: ["#10B981","#059669"] },
  finance:         { title: "Finance",        icon: "trending-up",    path: "/finance",         gradient: ["#EF4444","#DC2626"] },
  accounting:      { title: "Accounting",     icon: "stats-chart",    path: "/accounting",      gradient: ["#6366F1","#4F46E5"] },
  commissions:     { title: "Commissions",    icon: "ribbon",         path: "/commissions",     gradient: ["#F97316","#EA580C"] },
  payout:          { title: "Payout",         icon: "send",           path: "/payout",          gradient: ["#14B8A6","#0D9488"] },
  ess:             { title: "Self Service",   icon: "person-circle",  path: "/ess",             gradient: ["#EC4899","#DB2777"] },
  letters:         { title: "Letters",        icon: "document-text",  path: "/letters",         gradient: ["#6366F1","#4F46E5"] },
  reimbursements:  { title: "Reimbursements", icon: "receipt",        path: "/reimbursements",  gradient: ["#A855F7","#9333EA"] },
  performance:     { title: "Performance",    icon: "trophy",         path: "/performance",     gradient: ["#7C3AED","#6D28D9"] },
  assets:          { title: "Assets",         icon: "cube",           path: "/assets",          gradient: ["#64748B","#475569"] },
  inventory:       { title: "Inventory",      icon: "layers",         path: "/inventory",       gradient: ["#059669","#10B981"] },
  procurement:     { title: "Procurement",    icon: "cart",           path: "/procurement",     gradient: ["#D97706","#B45309"] },
  cameras:         { title: "Cameras",        icon: "videocam",       path: "/cameras",         gradient: ["#1D4ED8","#2563EB"] },
  communication:   { title: "Communication",  icon: "megaphone",      path: "/communication",   gradient: ["#EC4899","#BE185D"] },
  support:         { title: "Support",        icon: "chatbubbles",    path: "/support",         gradient: ["#2563EB","#1D4ED8"] },
  reports:         { title: "Reports",        icon: "bar-chart",      path: "/reports",         gradient: ["#14B8A6","#0891B2"] },
  ai:              { title: "AI Assist",      icon: "sparkles",       path: "/ai",              gradient: ["#7C3AED","#5B21B6"] },
  organization:    { title: "Organisation",   icon: "git-merge",      path: "/organization",    gradient: ["#0F766E","#0D9488"] },
  integrations:    { title: "Integrations",   icon: "git-branch",     path: "/integrations",    gradient: ["#374151","#1F2937"] },
};

export default function ModuleDetailScreen() {
  const router = useRouter();
  const { module: moduleName } = useLocalSearchParams<{ module: string }>();
  const meta = MODULE_META[moduleName ?? ""] ?? { title: moduleName, icon: "apps", path: "/", gradient: ["#4F46E5","#7C3AED"] as [string, string] };
  const [token, setToken] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const webViewRef = useRef<WebView>(null);

  useEffect(() => { getToken().then(setToken); }, []);

  useEffect(() => {
    const onBackPress = () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [canGoBack]);

  const base = getBaseUrl();
  const url = `${base}${meta.path}`;

  const isTrustedUrl = (targetUrl: string): boolean => {
    try {
      const parsedTarget = new URL(targetUrl);
      const parsedBase = new URL(base);
      return parsedTarget.origin === parsedBase.origin;
    } catch {
      return false;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.background }}>
      <LinearGradient colors={meta.gradient} style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            if (canGoBack && webViewRef.current) {
              webViewRef.current.goBack();
            } else {
              router.back();
            }
          }}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Ionicons name={meta.icon as any} size={20} color="rgba(255,255,255,0.85)" />
        <Text style={styles.title} numberOfLines={1}>{meta.title}</Text>
      </LinearGradient>

      {token ? (
        <WebView
          ref={webViewRef}
          source={{
            uri: url,
            headers: { Authorization: `Bearer ${token}`, "X-Requested-With": "XMLHttpRequest" },
          }}
          style={{ flex: 1 }}
          startInLoadingState
          javaScriptEnabled
          domStorageEnabled
          onNavigationStateChange={(navState) => {
            setCanGoBack(navState.canGoBack);
            // Handle session expiration/logout redirects
            if (navState.url.includes("/login") || navState.url.includes("/api/auth/signout")) {
              clearToken().finally(() => router.replace("/(auth)/login"));
            }
          }}
          onShouldStartLoadWithRequest={(request) => {
            if (isTrustedUrl(request.url)) {
              return true;
            }
            // Block untrusted origins from receiving Bearer token and open safely in system browser
            Linking.openURL(request.url).catch(() => {});
            return false;
          }}
        />
      ) : (
        <View style={styles.loading}>
          <Text style={Typography.body}>Loading…</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    paddingTop: Platform.OS === "ios" ? 60 : (StatusBar.currentHeight ?? 0) + 16,
    paddingBottom: Spacing.md, paddingHorizontal: Spacing.md,
  },
  backBtn: {
    padding: 4,
    marginRight: 4,
  },
  title:   { color: "#fff", fontSize: 18, fontWeight: "700", flex: 1 },
  loading: { flex: 1, justifyContent: "center", alignItems: "center" },
});

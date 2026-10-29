// Modules hub — gateway to all 40+ HRM modules with colour-coded cards

import { useCallback, useRef } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, StatusBar, TextInput, FlatList,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors, Spacing, Typography, Radius, Shadow } from "@/src/theme";
import { useState } from "react";

// ── Module catalogue ───────────────────────────────────────────────────────
interface Module {
  id: string;
  title: string;
  subtitle: string;
  icon: string;     // Ionicon name
  color: string;
  gradient: [string, string];
  route: string;
  tag?: string;
}

const MODULES: Module[] = [
  // People
  { id: "employees",    title: "Employees",      subtitle: "Directory & profiles",       icon: "people",              color: "#4F46E5", gradient: ["#4F46E5","#6366F1"] as [string,string], route: "/(modules)/employees",    tag: "People"    },
  { id: "onboarding",   title: "Onboarding",     subtitle: "New hire checklist",          icon: "person-add",          color: "#7C3AED", gradient: ["#7C3AED","#8B5CF6"] as [string,string], route: "/(modules)/[module]?module=onboarding",   tag: "People"    },
  { id: "exit",         title: "Exit",            subtitle: "Offboarding & clearance",    icon: "person-remove",       color: "#6B7280", gradient: ["#6B7280","#9CA3AF"] as [string,string], route: "/(modules)/[module]?module=exit",         tag: "People"    },
  { id: "recruitment",  title: "Recruitment",     subtitle: "Jobs, pipelines & ATS",      icon: "briefcase",           color: "#06B6D4", gradient: ["#06B6D4","#0EA5E9"] as [string,string], route: "/(modules)/recruitment",  tag: "People"    },
  // Time & Attendance
  { id: "attendance",   title: "Attendance",      subtitle: "Punches & corrections",      icon: "time",                color: "#4F46E5", gradient: ["#4F46E5","#06B6D4"], route: "/(tabs)/attendance",      tag: "Time"      },
  { id: "leave",        title: "Leave",           subtitle: "Requests & balances",        icon: "calendar",            color: "#10B981", gradient: ["#10B981","#059669"], route: "/(tabs)/leave",           tag: "Time"      },
  { id: "shift",        title: "Rosters",         subtitle: "Shift planning & rosters",   icon: "calendar-number",    color: "#F59E0B", gradient: ["#F59E0B","#D97706"], route: "/(modules)/rosters",      tag: "Time"      },
  { id: "tracking",     title: "Live Tracking",   subtitle: "GPS & geo-fencing",          icon: "map",                 color: "#DC2626", gradient: ["#DC2626","#EF4444"], route: "/(modules)/tracking",     tag: "Time"      },
  { id: "fieldforce",   title: "Field Force",     subtitle: "Plans, visits & routes",     icon: "navigate",            color: "#0EA5E9", gradient: ["#0EA5E9","#06B6D4"], route: "/(modules)/fieldforce",   tag: "Time"      },
  // Payroll & Finance
  { id: "payroll",      title: "Payroll",         subtitle: "Payslips & processing",      icon: "cash",                color: "#F59E0B", gradient: ["#F59E0B","#F97316"] as [string,string], route: "/(modules)/payroll",      tag: "Finance"   },
  { id: "ait",          title: "Tax (AIT)",        subtitle: "Income tax slabs & calc",    icon: "calculator",          color: "#8B5CF6", gradient: ["#8B5CF6","#7C3AED"] as [string,string], route: "/(modules)/[module]?module=ait",          tag: "Finance"   },
  { id: "pf",           title: "Provident Fund",  subtitle: "PF contributions & loans",   icon: "wallet",              color: "#10B981", gradient: ["#10B981","#059669"] as [string,string], route: "/(modules)/[module]?module=pf",           tag: "Finance"   },
  { id: "finance",      title: "Finance",         subtitle: "Loans, advances & expenses", icon: "trending-up",         color: "#EF4444", gradient: ["#EF4444","#DC2626"] as [string,string], route: "/(modules)/[module]?module=finance",      tag: "Finance"   },
  { id: "accounting",   title: "Accounting",      subtitle: "Vouchers, ledger & P&L",     icon: "stats-chart",         color: "#6366F1", gradient: ["#6366F1","#4F46E5"] as [string,string], route: "/(modules)/[module]?module=accounting",   tag: "Finance"   },
  { id: "commissions",  title: "Commissions",     subtitle: "Sales commission rules",     icon: "ribbon",              color: "#F97316", gradient: ["#F97316","#EA580C"] as [string,string], route: "/(modules)/[module]?module=commissions",  tag: "Finance"   },
  { id: "payout",       title: "Payout",          subtitle: "Salary disbursement",        icon: "send",                color: "#14B8A6", gradient: ["#14B8A6","#0D9488"] as [string,string], route: "/(modules)/[module]?module=payout",       tag: "Finance"   },
  // Self Service
  { id: "ess",          title: "Self Service",    subtitle: "Payslips, docs & profile",   icon: "person-circle",       color: "#EC4899", gradient: ["#EC4899","#DB2777"] as [string,string], route: "/(modules)/ess",          tag: "ESS"       },
  { id: "letters",      title: "Letters",         subtitle: "Experience & offer letters", icon: "document-text",       color: "#6366F1", gradient: ["#6366F1","#4F46E5"] as [string,string], route: "/(modules)/[module]?module=letters",      tag: "ESS"       },
  { id: "roadmap",      title: "Reimbursements",  subtitle: "Expense claims",             icon: "receipt",             color: "#A855F7", gradient: ["#A855F7","#9333EA"] as [string,string], route: "/(modules)/[module]?module=reimbursements",tag: "ESS"      },
  // Performance
  { id: "performance",  title: "Performance",     subtitle: "Goals, KPIs & reviews",      icon: "trophy",              color: "#7C3AED", gradient: ["#7C3AED","#6D28D9"] as [string,string], route: "/(modules)/performance",  tag: "Growth"    },
  // Assets & Inventory
  { id: "assets",       title: "Assets",          subtitle: "Employee asset tracking",    icon: "cube",                color: "#64748B", gradient: ["#64748B","#475569"] as [string,string], route: "/(modules)/[module]?module=assets",       tag: "Ops"       },
  { id: "inventory",    title: "Inventory",       subtitle: "Stock & adjustments",        icon: "layers",              color: "#059669", gradient: ["#059669","#10B981"] as [string,string], route: "/(modules)/[module]?module=inventory",    tag: "Ops"       },
  { id: "procurement",  title: "Procurement",     subtitle: "Purchase orders",            icon: "cart",                color: "#D97706", gradient: ["#D97706","#B45309"] as [string,string], route: "/(modules)/[module]?module=procurement",  tag: "Ops"       },
  { id: "cameras",      title: "Cameras",         subtitle: "Camera device manager",      icon: "videocam",            color: "#1D4ED8", gradient: ["#1D4ED8","#2563EB"] as [string,string], route: "/(modules)/[module]?module=cameras",      tag: "Ops"       },
  // Communication
  { id: "communication",title: "Communication",   subtitle: "Announcements & notices",    icon: "megaphone",           color: "#EC4899", gradient: ["#EC4899","#BE185D"] as [string,string], route: "/(modules)/[module]?module=communication",tag: "Comms"     },
  { id: "support",      title: "Support",         subtitle: "Help tickets & chat",        icon: "chatbubbles",         color: "#2563EB", gradient: ["#2563EB","#1D4ED8"] as [string,string], route: "/(modules)/support",      tag: "Comms"     },
  // Reports & Analytics
  { id: "reports",      title: "Reports",         subtitle: "HR analytics & exports",     icon: "bar-chart",           color: "#14B8A6", gradient: ["#14B8A6","#0891B2"] as [string,string], route: "/(modules)/reports",      tag: "Reports"   },
  { id: "ai",           title: "AI Assist",       subtitle: "NL queries & anomalies",     icon: "sparkles",            color: "#7C3AED", gradient: ["#7C3AED","#5B21B6"] as [string,string], route: "/(modules)/[module]?module=ai",           tag: "Reports"   },
  // Admin
  { id: "organization", title: "Organisation",    subtitle: "Departments & structure",    icon: "git-merge",           color: "#0F766E", gradient: ["#0F766E","#0D9488"] as [string,string], route: "/(modules)/[module]?module=organization", tag: "Admin"     },
  { id: "integrations", title: "Integrations",    subtitle: "API keys & webhooks",        icon: "git-branch",          color: "#374151", gradient: ["#374151","#1F2937"] as [string,string], route: "/(modules)/[module]?module=integrations", tag: "Admin"     },
];

const TAGS = ["All", "People", "Time", "Finance", "ESS", "Growth", "Ops", "Comms", "Reports", "Admin"];

export default function ModulesScreen() {
  const router  = useRouter();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("All");

  const filtered = MODULES.filter(m => {
    const matchTag = tag === "All" || m.tag === tag;
    const matchQ   = !q || m.title.toLowerCase().includes(q.toLowerCase()) || m.subtitle.toLowerCase().includes(q.toLowerCase());
    return matchTag && matchQ;
  });

  return (
    <View style={{ flex: 1, backgroundColor: Colors.background }}>
      {/* Header */}
      <LinearGradient colors={["#0F172A", "#1E293B"]} style={styles.header}>
        <Text style={styles.headerTitle}>All Modules</Text>
        <Text style={styles.headerSub}>{MODULES.length} modules available</Text>
        {/* Search */}
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={Colors.textTertiary} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search modules…"
            placeholderTextColor={Colors.textTertiary}
            value={q}
            onChangeText={setQ}
          />
          {q ? <TouchableOpacity onPress={() => setQ("")}><Ionicons name="close-circle" size={16} color={Colors.textTertiary} /></TouchableOpacity> : null}
        </View>
      </LinearGradient>

      {/* Tag filter chips */}
      <View style={{ backgroundColor: Colors.surface, paddingVertical: Spacing.sm, ...styles.shadow }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: Spacing.lg, gap: Spacing.sm }}>
          {TAGS.map(t => (
            <TouchableOpacity key={t} onPress={() => setTag(t)}
              style={[styles.tagChip, tag === t && styles.tagChipSel]}>
              <Text style={[styles.tagChipText, tag === t && { color: "#fff" }]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Module grid */}
      <FlatList
        data={filtered}
        keyExtractor={m => m.id}
        numColumns={2}
        contentContainerStyle={{ padding: Spacing.md, gap: Spacing.md }}
        columnWrapperStyle={{ gap: Spacing.md }}
        showsVerticalScrollIndicator={false}
        renderItem={({ item: m }) => (
          <TouchableOpacity
            style={styles.modCard}
            activeOpacity={0.82}
            onPress={() => router.push(m.route as any)}
          >
            <LinearGradient colors={m.gradient} style={styles.modGrad}>
              <View style={styles.modIconWrap}>
                <Ionicons name={m.icon as any} size={24} color="#fff" />
              </View>
              <Text style={styles.modTitle}>{m.title}</Text>
              <Text style={styles.modSub} numberOfLines={2}>{m.subtitle}</Text>
            </LinearGradient>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: Platform.OS === "ios" ? 60 : (StatusBar.currentHeight ?? 0) + 16,
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  headerTitle: { color: "#fff", fontSize: 24, fontWeight: "800" },
  headerSub:   { color: "rgba(255,255,255,0.6)", fontSize: 13, marginTop: 2, marginBottom: Spacing.md },
  searchWrap: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 10,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
  },
  searchInput: { flex: 1, color: "#fff", fontSize: 15 },
  shadow: { ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } }, android: { elevation: 3 } }) },
  tagChip: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: Radius.full, borderWidth: 1.5, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  tagChipSel:  { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tagChipText: { fontSize: 12, fontWeight: "600", color: Colors.textSecondary },
  modCard: { flex: 1, borderRadius: Radius.lg, overflow: "hidden", ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }, android: { elevation: 3 } }) },
  modGrad: { padding: Spacing.lg, minHeight: 130, justifyContent: "space-between" },
  modIconWrap: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.18)",
    justifyContent: "center", alignItems: "center",
    marginBottom: Spacing.sm,
  },
  modTitle: { color: "#fff", fontWeight: "700", fontSize: 14, marginBottom: 3 },
  modSub:   { color: "rgba(255,255,255,0.72)", fontSize: 11, fontWeight: "500" },
});

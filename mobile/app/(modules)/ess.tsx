// Employee Self-Service (ESS) — native screen
// Payslips quick link, documents, announcements, expense reimbursements

import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, StatusBar, RefreshControl,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useFetch } from "@/src/hooks/useFetch";
import { Card, Badge, EmptyState, SectionHeader, Avatar } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";
import { useAuthStore } from "@/src/lib/auth";

interface Announcement {
  id: string; title: string; body: string; createdAt: string; priority?: string;
}
interface Document {
  id: string; name: string; type: string; createdAt: string;
}
interface Reimbursement {
  id: string; title: string; amount: number; status: string; date: string;
}

const ESS_SHORTCUTS = [
  { icon: "cash-outline",          label: "Payslips",        color: "#F59E0B", route: "/(modules)/payroll"         },
  { icon: "document-text-outline", label: "Letters",         color: "#6366F1", route: "/(modules)/letters"         },
  { icon: "receipt-outline",       label: "Reimbursements",  color: "#A855F7", route: "/(modules)/reimbursements"  },
  { icon: "trophy-outline",        label: "Performance",     color: "#7C3AED", route: "/(modules)/performance"     },
  { icon: "wallet-outline",        label: "Prov. Fund",      color: "#10B981", route: "/(modules)/pf"              },
  { icon: "calculator-outline",    label: "Tax (AIT)",       color: "#8B5CF6", route: "/(modules)/ait"             },
  { icon: "cube-outline",          label: "My Assets",       color: "#64748B", route: "/(modules)/assets"          },
  { icon: "star-outline",          label: "Commissions",     color: "#F97316", route: "/(modules)/commissions"     },
];

export default function EssScreen() {
  const { user } = useAuthStore();
  const router   = useRouter();
  const { data: announcements, refreshing: r1, refresh: re1 } = useFetch<{ data: Announcement[] }>("announcements.list", { page: 1, limit: 5 });
  const { data: docs,          refreshing: r2, refresh: re2 } = useFetch<{ data: Document[] }>("ess.myDocuments", { page: 1 });
  const { data: reimbs,        refreshing: r3, refresh: re3 } = useFetch<{ data: Reimbursement[] }>("roadmap.myReimbursements", { page: 1 });

  const annList   = announcements?.data ?? [];
  const docList   = docs?.data          ?? [];
  const reimbList = reimbs?.data        ?? [];
  const refreshing = r1 || r2 || r3;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor="#EC4899" onRefresh={() => { re1(); re2(); re3(); }} />}
    >
      {/* Header */}
      <LinearGradient colors={["#EC4899", "#7C3AED"]} style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Self Service</Text>
            <Text style={styles.sub}>Everything you need, in one place</Text>
          </View>
          <Avatar name={user?.name ?? "U"} size={44} style={{ borderWidth: 2, borderColor: "rgba(255,255,255,0.4)" }} />
        </View>
      </LinearGradient>

      <View style={styles.body}>
        {/* Shortcuts grid */}
        <View style={styles.grid}>
          {ESS_SHORTCUTS.map(s => (
            <TouchableOpacity key={s.label} style={styles.shortcut} activeOpacity={0.78}
              onPress={() => router.push(s.route as any)}>
              <View style={[styles.shortcutIcon, { backgroundColor: s.color + "18" }]}>
                <Ionicons name={s.icon as any} size={22} color={s.color} />
              </View>
              <Text style={styles.shortcutLabel}>{s.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Announcements */}
        <SectionHeader title="Announcements" style={styles.sectionGap} />
        {annList.length === 0
          ? <Card><EmptyState icon="📢" title="No announcements" /></Card>
          : annList.map(a => (
            <Card key={a.id} style={styles.itemCard}>
              <View style={styles.annHeader}>
                <View style={styles.annDot} />
                <Text style={[Typography.h4, { flex: 1 }]} numberOfLines={1}>{a.title}</Text>
                {a.priority === "HIGH" && <Badge label="HIGH" />}
              </View>
              <Text style={[Typography.bodyS, { marginTop: Spacing.sm }]} numberOfLines={3}>{a.body}</Text>
              <Text style={[Typography.caption, { marginTop: Spacing.sm }]}>
                {new Date(a.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </Text>
            </Card>
          ))
        }

        {/* My Documents */}
        <SectionHeader title="My Documents" style={styles.sectionGap}
          action="See all" onAction={() => router.push("/(modules)/letters" as any)} />
        {docList.length === 0
          ? <Card><EmptyState icon="📄" title="No documents yet" /></Card>
          : docList.map(d => (
            <Card key={d.id} style={[styles.itemCard, { flexDirection: "row", alignItems: "center", gap: Spacing.md }]}>
              <View style={styles.docIcon}>
                <Ionicons name="document-text" size={20} color={Colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={Typography.h4} numberOfLines={1}>{d.name}</Text>
                <Text style={Typography.bodyS}>{d.type} · {new Date(d.createdAt).toLocaleDateString()}</Text>
              </View>
              <Ionicons name="download-outline" size={18} color={Colors.textTertiary} />
            </Card>
          ))
        }

        {/* Reimbursements */}
        <SectionHeader title="Reimbursements" style={styles.sectionGap}
          action="Apply" onAction={() => router.push("/(modules)/reimbursements" as any)} />
        {reimbList.length === 0
          ? <Card><EmptyState icon="🧾" title="No reimbursements" /></Card>
          : reimbList.map(r => (
            <Card key={r.id} style={[styles.itemCard, { flexDirection: "row", alignItems: "center" }]}>
              <View style={{ flex: 1 }}>
                <Text style={Typography.h4} numberOfLines={1}>{r.title}</Text>
                <Text style={Typography.bodyS}>{r.date}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                <Text style={{ fontWeight: "700", color: Colors.primary, fontSize: 15 }}>৳{r.amount.toLocaleString()}</Text>
                <Badge label={r.status} />
              </View>
            </Card>
          ))
        }

        <View style={{ height: 32 }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: Platform.OS === "ios" ? 60 : (StatusBar.currentHeight ?? 0) + 16,
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xxl,
  },
  headerRow: { flexDirection: "row", alignItems: "center" },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub:   { color: "rgba(255,255,255,0.75)", fontSize: 13, marginTop: 2 },
  body:  { padding: Spacing.lg },
  grid:  { flexDirection: "row", flexWrap: "wrap", gap: Spacing.md, marginBottom: Spacing.sm },
  shortcut: { width: "22%", alignItems: "center", gap: 6 },
  shortcutIcon: { width: 52, height: 52, borderRadius: 16, justifyContent: "center", alignItems: "center" },
  shortcutLabel: { fontSize: 10, fontWeight: "600", color: Colors.textSecondary, textAlign: "center" },
  sectionGap: { marginTop: Spacing.xl, marginBottom: Spacing.md },
  itemCard: { marginBottom: Spacing.sm },
  annHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  annDot:    { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.primary },
  docIcon: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: Colors.primaryLight,
    justifyContent: "center", alignItems: "center",
  },
});

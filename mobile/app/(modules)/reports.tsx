// Reports & Analytics screen — HR dashboards, export options

import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, StatusBar, RefreshControl, Alert,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFetch } from "@/src/hooks/useFetch";
import { rpc } from "@/src/lib/api";
import { Card, EmptyState, SectionHeader, StatChip } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface ReportCard {
  id: string; title: string; description: string; icon: string; color: string;
  action: string;
}

const REPORT_CARDS: ReportCard[] = [
  { id: "headcount",    title: "Headcount",         description: "Total active employees by department", icon: "people",       color: "#4F46E5", action: "reports.headcount"     },
  { id: "attendance",   title: "Attendance Summary", description: "Daily presence & absence breakdown",  icon: "time",         color: "#06B6D4", action: "reports.attendance"    },
  { id: "leave",        title: "Leave Analysis",     description: "Leave usage & balance trends",        icon: "calendar",     color: "#10B981", action: "reports.leave"         },
  { id: "payroll",      title: "Payroll Summary",    description: "Cost centre & salary breakdown",      icon: "cash",         color: "#F59E0B", action: "reports.payroll"       },
  { id: "turnover",     title: "Turnover Report",    description: "Attrition & retention metrics",       icon: "trending-up",  color: "#EF4444", action: "reports.turnover"      },
  { id: "performance",  title: "Performance",        description: "KPI scores by team & period",         icon: "trophy",       color: "#7C3AED", action: "reports.performance"   },
  { id: "recruitment",  title: "Recruitment",        description: "Pipeline conversion & time-to-hire",  icon: "briefcase",    color: "#0EA5E9", action: "reports.recruitment"   },
  { id: "fieldforce",   title: "Field Force",         description: "Visit completion & route adherence",  icon: "navigate",     color: "#F97316", action: "reports.fieldforce"    },
];

interface OverviewStat { label: string; value: number | string }

export default function ReportsScreen() {
  const { data: stats, refreshing, refresh } = useFetch<OverviewStat[]>("reports.overview", {});
  const overviewStats = stats ?? [];

  const handleRun = async (card: ReportCard) => {
    try {
      await rpc(card.action, {});
      Alert.alert("Report Ready", `${card.title} exported to your downloads.`);
    } catch {
      Alert.alert("Error", "Could not generate report at this time.");
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.info} onRefresh={refresh} />}
    >
      <LinearGradient colors={["#14B8A6", "#0891B2"]} style={styles.header}>
        <Text style={styles.title}>Reports & Analytics</Text>
        <Text style={styles.sub}>Data-driven HR insights</Text>
        {/* Overview stats */}
        {overviewStats.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: Spacing.md }}>
            {overviewStats.map(s => (
              <View key={s.label} style={styles.statPill}>
                <Text style={styles.statVal}>{s.value}</Text>
                <Text style={styles.statLabel}>{s.label}</Text>
              </View>
            ))}
          </ScrollView>
        )}
      </LinearGradient>

      <View style={styles.body}>
        <SectionHeader title="Available Reports" style={{ marginBottom: Spacing.md }} />
        {REPORT_CARDS.map(card => (
          <Card key={card.id} style={styles.rCard} onPress={() => handleRun(card)}>
            <View style={[styles.rIcon, { backgroundColor: card.color + "18" }]}>
              <Ionicons name={card.icon as any} size={22} color={card.color} />
            </View>
            <View style={{ flex: 1, marginLeft: Spacing.md }}>
              <Text style={Typography.h4}>{card.title}</Text>
              <Text style={[Typography.bodyS, { marginTop: 2 }]}>{card.description}</Text>
            </View>
            <View style={styles.exportBtn}>
              <Ionicons name="download-outline" size={16} color={card.color} />
            </View>
          </Card>
        ))}
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
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub:   { color: "rgba(255,255,255,0.75)", fontSize: 13, marginTop: 2 },
  statPill: {
    backgroundColor: "rgba(255,255,255,0.18)", borderRadius: Radius.lg,
    padding: Spacing.md, alignItems: "center", marginRight: Spacing.sm,
    minWidth: 80, borderWidth: 1, borderColor: "rgba(255,255,255,0.22)",
  },
  statVal:   { color: "#fff", fontSize: 20, fontWeight: "800" },
  statLabel: { color: "rgba(255,255,255,0.7)", fontSize: 10, fontWeight: "600", marginTop: 2 },
  body:  { padding: Spacing.lg },
  rCard: { flexDirection: "row", alignItems: "center", marginBottom: Spacing.sm },
  rIcon: { width: 46, height: 46, borderRadius: 13, justifyContent: "center", alignItems: "center" },
  exportBtn: {
    width: 34, height: 34, borderRadius: 8,
    backgroundColor: Colors.surfaceAlt,
    justifyContent: "center", alignItems: "center",
  },
});

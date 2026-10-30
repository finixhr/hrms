// Reports & Analytics screen.
//
// SERVER CONTRACTS (verified 2026-10-30):
//   reports.attendanceOverview (routes/reports.ts:1886, perm attendance.view)
//     → { kpis: { present, absent, late, … }, trend, branchStats, departmentStats,
//         methodDistribution, compliance, integrityDistribution, period: { from, to } }
//   reports.templates.list (routes/reports.ts:1488, perm reports.view)
//     → { templates: [...], deliveries: [...] }
// There are NO reports.overview / reports.headcount / reports.payroll / …
// actions — the nine REPORT_CARDS the old screen "ran" do not exist, and the
// old success alert ("exported to your downloads") claimed a download that
// never happened. This screen now renders REAL report data (attendance
// overview for the current month) and lists the tenant's saved report
// templates. Deep report building/export remains a web-portal workflow.
//
// The Modules hub gates this screen behind report/attendance permissions —
// employees without them see the server's honest permission error here.

import {
  View, Text, ScrollView, StyleSheet,
  Platform, StatusBar, RefreshControl,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFetch } from "@/src/hooks/useFetch";
import { Card, Badge, EmptyState, SectionHeader, StatChip } from "@/src/components/ui";
import { Colors, Spacing, Typography } from "@/src/theme";

interface AttKpis {
  present?: number;
  absent?: number;
  late?: number;
  [k: string]: unknown;
}

interface AttOverview {
  kpis: AttKpis;
  trend?: Array<{ date: string; present?: number; absent?: number; late?: number }>;
  branchStats?: Array<{ name?: string; [k: string]: unknown }>;
  period?: { from?: string; to?: string };
}

interface ReportTemplate {
  id: string;
  name: string;
  reportKey: string;
  active?: boolean;
  [k: string]: unknown;
}

function monthStartIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReportsScreen() {
  const { data: overview, loading, refreshing, refresh } = useFetch<AttOverview>(
    "reports.attendanceOverview",
    { from: monthStartIso(), to: todayIso() },
  );
  const { data: templatesData } = useFetch<{ templates: ReportTemplate[] }>("reports.templates.list", {});

  const kpis = overview?.kpis ?? {};
  const templates = templatesData?.templates ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.info} onRefresh={refresh} />}
    >
      <LinearGradient colors={["#14B8A6", "#0891B2"]} style={styles.header}>
        <Text style={styles.title}>Reports & Analytics</Text>
        <Text style={styles.sub}>
          {overview?.period?.from
            ? `Attendance overview · ${overview.period.from} → ${overview.period.to ?? todayIso()}`
            : "Attendance overview"}
        </Text>
      </LinearGradient>

      <View style={styles.body}>
        {/* Attendance overview (real data, current month) */}
        <SectionHeader title="Attendance Overview" style={{ marginBottom: Spacing.md }} />
        {loading ? (
          <Card><EmptyState icon="⏳" title="Loading report…" /></Card>
        ) : !overview ? (
          <Card>
            <EmptyState
              icon="🔒"
              title="Report unavailable"
              subtitle="Your account needs the attendance view permission, or the server could not be reached."
            />
          </Card>
        ) : (
          <>
            <View style={{ flexDirection: "row", gap: Spacing.sm }}>
              <StatChip value={kpis.present ?? 0} label="Present" color={Colors.success} />
              <StatChip value={kpis.absent ?? 0}  label="Absent"  color={Colors.danger} />
              <StatChip value={kpis.late ?? 0}    label="Late"    color={Colors.warning} />
            </View>

            {(overview.trend ?? []).length > 0 && (
              <Card style={{ marginTop: Spacing.md }}>
                <Text style={Typography.h4}>Daily trend</Text>
                <View style={styles.trendWrap}>
                  {(overview.trend ?? []).slice(-14).reverse().map((t) => (
                    <View key={t.date} style={styles.trendRow}>
                      <Text style={[Typography.caption, { flex: 1 }]}>{t.date?.slice(5)}</Text>
                      <Text style={[Typography.bodyS, { color: Colors.success }]}>P {t.present ?? 0}</Text>
                      <Text style={[Typography.bodyS, { color: Colors.danger, marginLeft: Spacing.md }]}>A {t.absent ?? 0}</Text>
                      <Text style={[Typography.bodyS, { color: Colors.warning, marginLeft: Spacing.md }]}>L {t.late ?? 0}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            )}

            {(overview.branchStats ?? []).length > 0 && (
              <Card style={{ marginTop: Spacing.md }}>
                <Text style={Typography.h4}>By branch</Text>
                {(overview.branchStats ?? []).slice(0, 10).map((b, i) => (
                  <View key={i} style={styles.trendRow}>
                    <Text style={[Typography.bodyS, { flex: 1 }]}>{b.name ?? "—"}</Text>
                  </View>
                ))}
              </Card>
            )}
          </>
        )}

        {/* Saved report templates (read-only view of the web-portal registry) */}
        <SectionHeader title="Scheduled Report Templates" style={styles.sectionGap} />
        {templates.length === 0 ? (
          <Card>
            <EmptyState
              icon="📊"
              title="No report templates"
              subtitle="Templates created in the web portal's Reports module appear here"
            />
          </Card>
        ) : (
          templates.map(t => (
            <Card key={t.id} style={[styles.rCard]}>
              <View style={[styles.rIcon, { backgroundColor: "#14B8A6" + "18" }]}>
                <Ionicons name="document-text-outline" size={22} color="#14B8A6" />
              </View>
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
                <Text style={Typography.h4} numberOfLines={1}>{t.name}</Text>
                <Text style={[Typography.bodyS, { marginTop: 2 }]}>{t.reportKey}</Text>
              </View>
              <Badge label={t.active ? "Active" : "Paused"} />
            </Card>
          ))
        )}

        <Card style={{ marginTop: Spacing.lg }}>
          <Text style={[Typography.bodyS, { color: Colors.textSecondary }]}>
            Full report building, exports and scheduled delivery are managed in the
            Finix HR web portal&apos;s Reports module.
          </Text>
        </Card>
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
  body:  { padding: Spacing.lg },
  sectionGap: { marginTop: Spacing.xl, marginBottom: Spacing.md },
  rCard: { flexDirection: "row", alignItems: "center", marginBottom: Spacing.sm },
  rIcon: { width: 46, height: 46, borderRadius: 13, justifyContent: "center", alignItems: "center" },
  trendWrap: { marginTop: Spacing.sm, gap: 4 },
  trendRow: { flexDirection: "row", alignItems: "center", paddingVertical: 2 },
});

// Performance screen — my tasks/goals, KPI assignments, review history.
//
// SERVER CONTRACTS (verified 2026-10-30):
//   ess.tasks        (routes/ess.ts:257) → Task[] (own tasks, take 200):
//     { id, title, progress (0–100), status, priority, dueDate, … }
//   ess.performance  (routes/ess.ts:267) → { reviews, kpis }:
//     reviews: PerformanceReview[] — { id, cycleName, overallRating, status, … }
//       (only SUBMITTED/ACKNOWLEDGED/FINAL are employee-visible — ESS-03)
//     kpis: KpiAssignment[] — { id, periodLabel, status, dueDate,
//       results: [{ name, target, actual, achievementPct, weight, score, rating }] }
// There are NO `performance.myGoals/myKpis/myReviews` actions on the server.

import {
  View, Text, ScrollView, StyleSheet,
  Platform, StatusBar, RefreshControl,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFetch } from "@/src/hooks/useFetch";
import { Card, Badge, EmptyState, SectionHeader } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface Task {
  id: string;
  title: string;
  progress: number;
  status: string;
  priority?: string;
  dueDate?: string | null;
}

interface KpiResult {
  name: string;
  target?: number;
  actual?: number;
  achievementPct?: number;
  score?: number;
  rating?: string;
}

interface KpiAssignment {
  id: string;
  periodLabel: string;
  status: string;
  dueDate?: string | null;
  results: KpiResult[];
}

interface Review {
  id: string;
  cycleName?: string;
  overallRating: number;
  status: string;
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, Math.round((value / Math.max(max, 1)) * 100));
  return (
    <View style={{ height: 6, backgroundColor: Colors.border, borderRadius: 3, overflow: "hidden", marginTop: 6 }}>
      <View style={{ height: 6, width: `${pct}%`, backgroundColor: color, borderRadius: 3 }} />
    </View>
  );
}

export default function PerformanceScreen() {
  const { data: tasksData, refreshing: r1, refresh: re1 } = useFetch<Task[]>("ess.tasks", {});
  const { data: perfData,  refreshing: r2, refresh: re2 } = useFetch<{ reviews: Review[]; kpis: KpiAssignment[] }>("ess.performance", {});

  const tasks   = tasksData ?? [];
  const kpis    = perfData?.kpis    ?? [];
  const reviews = perfData?.reviews ?? [];

  const latestReview = reviews[0];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={r1 || r2} tintColor={Colors.accent} onRefresh={() => { re1(); re2(); }} />}
    >
      <LinearGradient colors={["#7C3AED", "#6D28D9"]} style={styles.header}>
        <Text style={styles.title}>Performance</Text>
        <Text style={styles.sub}>Tasks, KPIs & appraisals</Text>

        {latestReview && (
          <View style={styles.scoreCard}>
            <View style={styles.scoreCircle}>
              <Text style={styles.scorePct}>{latestReview.overallRating.toFixed(1)}</Text>
              <Text style={styles.scoreLabel}>Rating</Text>
            </View>
            <View style={{ flex: 1, marginLeft: Spacing.lg }}>
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>{latestReview.cycleName ?? "Latest review"}</Text>
              <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, marginTop: 2 }}>
                Overall rating from your latest appraisal
              </Text>
              <Badge label={latestReview.status} style={{ marginTop: 8, alignSelf: "flex-start" }} />
            </View>
          </View>
        )}
      </LinearGradient>

      <View style={styles.body}>
        {/* Tasks / goals */}
        <SectionHeader title="My Tasks & Goals" style={{ marginBottom: Spacing.md }} />
        {tasks.length === 0
          ? <Card><EmptyState icon="🎯" title="No tasks assigned" subtitle="Tasks assigned by HR or your manager will appear here" /></Card>
          : tasks.slice(0, 20).map(t => {
            const color = t.progress >= 100 ? Colors.success : t.progress >= 60 ? Colors.warning : Colors.primary;
            return (
              <Card key={t.id} style={styles.goalCard}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={Typography.h4} numberOfLines={2}>{t.title}</Text>
                    <Text style={[Typography.bodyS, { marginTop: 2 }]}>
                      {t.dueDate ? `Due ${new Date(t.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ` : ""}
                      {t.priority ?? "—"} priority
                    </Text>
                  </View>
                  <Text style={{ color, fontWeight: "800", fontSize: 18 }}>{t.progress}%</Text>
                </View>
                <ProgressBar value={t.progress} max={100} color={color} />
              </Card>
            );
          })
        }

        {/* KPIs */}
        <SectionHeader title="KPI Scores" style={styles.sectionGap} />
        {kpis.length === 0
          ? <Card><EmptyState icon="📊" title="No KPIs yet" subtitle="KPI assignments for your role will appear here" /></Card>
          : kpis.map(k => (
            <Card key={k.id} style={styles.goalCard}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={Typography.h4}>{k.periodLabel}</Text>
                <Badge label={k.status} />
              </View>
              {k.dueDate && (
                <Text style={[Typography.bodyS, { marginTop: 2 }]}>
                  Due {new Date(k.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </Text>
              )}
              {(k.results ?? []).slice(0, 6).map((r, i) => {
                const pct = Math.min(100, Math.max(0, r.achievementPct ?? 0));
                const color = pct >= 80 ? Colors.success : pct >= 50 ? Colors.warning : Colors.danger;
                return (
                  <View key={`${k.id}-${i}`} style={{ marginTop: Spacing.md }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={Typography.bodyS} numberOfLines={1}>{r.name}</Text>
                      <Text style={Typography.bodyS}>{pct}%</Text>
                    </View>
                    <ProgressBar value={pct} max={100} color={color} />
                  </View>
                );
              })}
            </Card>
          ))
        }

        {/* Reviews */}
        <SectionHeader title="Appraisal History" style={styles.sectionGap} />
        {reviews.length === 0
          ? <Card><EmptyState icon="🏆" title="No appraisals yet" subtitle="Submitted reviews will appear here" /></Card>
          : reviews.map(r => (
            <Card key={r.id} style={[styles.goalCard, { flexDirection: "row", alignItems: "center" }]}>
              <View style={styles.reviewIcon}>
                <Ionicons name="star" size={18} color={Colors.accent} />
              </View>
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
                <Text style={Typography.h4}>{r.cycleName ?? "Review cycle"}</Text>
                <Text style={Typography.bodyS}>Overall rating {r.overallRating.toFixed(1)}</Text>
              </View>
              <Badge label={r.status} />
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
  sub:   { color: "rgba(255,255,255,0.75)", fontSize: 13, marginTop: 2, marginBottom: Spacing.lg },
  scoreCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.14)", borderRadius: Radius.lg,
    padding: Spacing.lg, borderWidth: 1, borderColor: "rgba(255,255,255,0.22)",
  },
  scoreCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: 3, borderColor: "rgba(255,255,255,0.5)",
    justifyContent: "center", alignItems: "center",
  },
  scorePct:   { color: "#fff", fontSize: 20, fontWeight: "800" },
  scoreLabel: { color: "rgba(255,255,255,0.7)", fontSize: 10 },
  body:       { padding: Spacing.lg },
  sectionGap: { marginTop: Spacing.xl, marginBottom: Spacing.md },
  goalCard:   { marginBottom: Spacing.sm },
  reviewIcon: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: Colors.accentLight, justifyContent: "center", alignItems: "center",
  },
});

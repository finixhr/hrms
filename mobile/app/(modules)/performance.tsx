// Performance screen — goals, KPIs, review history

import {
  View, Text, ScrollView, StyleSheet,
  Platform, StatusBar, RefreshControl, TouchableOpacity,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFetch } from "@/src/hooks/useFetch";
import { Card, Badge, EmptyState, SectionHeader } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface Goal {
  id: string; title: string; target: number; achieved: number; unit: string; status: string; dueDate?: string;
}
interface KPI {
  id: string; name: string; score: number; maxScore: number; period: string;
}
interface Review {
  id: string; period: string; overallScore: number; maxScore: number; status: string; reviewedBy?: string;
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
  const { data: goalsData,   refreshing: r1, refresh: re1 } = useFetch<{ data: Goal[] }>("performance.myGoals", {});
  const { data: kpisData,    refreshing: r2, refresh: re2 } = useFetch<{ data: KPI[] }>("performance.myKpis", {});
  const { data: reviewsData, refreshing: r3, refresh: re3 } = useFetch<{ data: Review[] }>("performance.myReviews", {});

  const goals   = goalsData?.data   ?? [];
  const kpis    = kpisData?.data    ?? [];
  const reviews = reviewsData?.data ?? [];

  // Overall score from latest review
  const latestReview = reviews[0];
  const overallPct   = latestReview
    ? Math.round((latestReview.overallScore / Math.max(latestReview.maxScore, 1)) * 100)
    : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={r1 || r2 || r3} tintColor={Colors.accent} onRefresh={() => { re1(); re2(); re3(); }} />}
    >
      <LinearGradient colors={["#7C3AED", "#6D28D9"]} style={styles.header}>
        <Text style={styles.title}>Performance</Text>
        <Text style={styles.sub}>Goals, KPIs & appraisals</Text>

        {/* Score ring placeholder */}
        {overallPct != null && (
          <View style={styles.scoreCard}>
            <View style={styles.scoreCircle}>
              <Text style={styles.scorePct}>{overallPct}%</Text>
              <Text style={styles.scoreLabel}>Overall</Text>
            </View>
            <View style={{ flex: 1, marginLeft: Spacing.lg }}>
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>{latestReview!.period}</Text>
              <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, marginTop: 2 }}>
                Score: {latestReview!.overallScore}/{latestReview!.maxScore}
              </Text>
              <Badge label={latestReview!.status} style={{ marginTop: 8, alignSelf: "flex-start" }} />
            </View>
          </View>
        )}
      </LinearGradient>

      <View style={styles.body}>
        {/* Goals */}
        <SectionHeader title="My Goals" style={{ marginBottom: Spacing.md }} />
        {goals.length === 0
          ? <Card><EmptyState icon="🎯" title="No goals set" subtitle="Goals assigned by HR will appear here" /></Card>
          : goals.map(g => {
            const pct   = Math.min(100, Math.round((g.achieved / Math.max(g.target, 1)) * 100));
            const color = pct >= 100 ? Colors.success : pct >= 60 ? Colors.warning : Colors.danger;
            return (
              <Card key={g.id} style={styles.goalCard}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={Typography.h4} numberOfLines={2}>{g.title}</Text>
                    <Text style={[Typography.bodyS, { marginTop: 2 }]}>
                      {g.achieved} / {g.target} {g.unit}
                      {g.dueDate && ` · Due ${new Date(g.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
                    </Text>
                  </View>
                  <Text style={{ color, fontWeight: "800", fontSize: 18 }}>{pct}%</Text>
                </View>
                <ProgressBar value={g.achieved} max={g.target} color={color} />
              </Card>
            );
          })
        }

        {/* KPIs */}
        <SectionHeader title="KPI Scores" style={styles.sectionGap} />
        {kpis.length === 0
          ? <Card><EmptyState icon="📊" title="No KPIs yet" /></Card>
          : kpis.map(k => {
            const pct   = Math.min(100, Math.round((k.score / Math.max(k.maxScore, 1)) * 100));
            const color = pct >= 80 ? Colors.success : pct >= 50 ? Colors.warning : Colors.danger;
            return (
              <Card key={k.id} style={[styles.goalCard, { flexDirection: "row", alignItems: "center" }]}>
                <View style={{ flex: 1 }}>
                  <Text style={Typography.h4}>{k.name}</Text>
                  <Text style={Typography.bodyS}>{k.period}</Text>
                  <ProgressBar value={k.score} max={k.maxScore} color={color} />
                </View>
                <View style={{ alignItems: "center", marginLeft: Spacing.lg }}>
                  <Text style={{ color, fontWeight: "800", fontSize: 22 }}>{pct}%</Text>
                  <Text style={Typography.caption}>{k.score}/{k.maxScore}</Text>
                </View>
              </Card>
            );
          })
        }

        {/* Reviews */}
        <SectionHeader title="Appraisal History" style={styles.sectionGap} />
        {reviews.length === 0
          ? <Card><EmptyState icon="🏆" title="No appraisals yet" /></Card>
          : reviews.map(r => (
            <Card key={r.id} style={[styles.goalCard, { flexDirection: "row", alignItems: "center" }]}>
              <View style={styles.reviewIcon}>
                <Ionicons name="star" size={18} color={Colors.accent} />
              </View>
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
                <Text style={Typography.h4}>{r.period}</Text>
                {r.reviewedBy && <Text style={Typography.bodyS}>By {r.reviewedBy}</Text>}
              </View>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                <Text style={{ fontWeight: "800", fontSize: 18, color: Colors.accent }}>
                  {r.overallScore}/{r.maxScore}
                </Text>
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

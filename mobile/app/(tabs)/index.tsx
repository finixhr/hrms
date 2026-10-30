// Home / Dashboard screen — greeting, quick stats, quick actions, recent activity

import { useEffect, useState, useCallback } from "react";
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  StyleSheet, Platform, StatusBar,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { rpc } from "@/src/lib/api";
import { useAuthStore } from "@/src/lib/auth";
<<<<<<< HEAD
import { Avatar, Card, StatChip, SectionHeader, EmptyState } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface Stats {
  // ess.dashboard contract (routes/ess.ts:350)
  attendance: { present: number; late: number; absent: number; overtimeMinutes: number };
  casualRemaining: number;
  openTasks: number;
  unreadNotifications: number;
  activeLoans?: number;
  pendingExpenses?: number;
}

interface AttToday {
  checkIn?: string | null;
  checkOut?: string | null;
  status?: string;
}

interface Notification {
=======
import { Avatar, Card, Badge, StatChip, SectionHeader, EmptyState } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius, Shadow } from "@/src/theme";

interface Stats {
  presentToday: number;
  absentToday: number;
  pendingLeaves: number;
  pendingLoans: number;
  totalEmployees: number;
  lateToday?: number;
  myCheckin?: string | null;
  myCheckout?: string | null;
  myLeaveBalance?: number;
}

interface Activity {
>>>>>>> origin/main
  id: string;
  title: string;
  message: string;
  type: string;
<<<<<<< HEAD
  readAt?: string | null;
  createdAt: string;
=======
  createdAt: string;
  read: boolean;
>>>>>>> origin/main
}

const QUICK_ACTIONS = [
  { icon: "time",          label: "Check In",    color: Colors.primary,  route: "/(tabs)/attendance" },
  { icon: "calendar",      label: "Apply Leave", color: Colors.success,  route: "/(tabs)/leave"      },
  { icon: "cash",          label: "Payslip",     color: Colors.warning,  route: "/(tabs)/modules"    },
  { icon: "people",        label: "Directory",   color: Colors.accent,   route: "/(tabs)/modules"    },
  { icon: "bar-chart",     label: "Reports",     color: Colors.info,     route: "/(tabs)/modules"    },
  { icon: "notifications", label: "Requests",    color: "#EC4899",       route: "/(tabs)/modules"    },
];

function greet() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function HomeScreen() {
  const { user }        = useAuthStore();
  const router          = useRouter();
<<<<<<< HEAD
  const [stats, setStats]         = useState<Stats | null>(null);
  const [today, setToday]         = useState<AttToday | null>(null);
  const [activity, setActivity]   = useState<Notification[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (_silent = false) => {
    try {
      // Employee-plane contracts: ess.dashboard (personal KPIs),
      // ess.attendance (today's punch pair), notifications.list (bare array —
      // the old code read `.data` from a response that has no wrapper).
      const [s, a, n] = await Promise.allSettled([
        rpc<Stats>("ess.dashboard", {}),
        rpc<{ today: AttToday | null }>("ess.attendance", {}),
        rpc<Notification[]>("notifications.list", {}),
      ]);
      if (s.status === "fulfilled") setStats(s.value);
      if (a.status === "fulfilled") setToday(a.value?.today ?? null);
      if (n.status === "fulfilled") setActivity((n.value ?? []).slice(0, 5));
=======
  const [stats, setStats]       = useState<Stats | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    try {
      const [s, a] = await Promise.allSettled([
        rpc<Stats>("dashboard.stats", {}),
        rpc<{ data: Activity[] }>("notifications.list", { page: 1, limit: 5 }),
      ]);
      if (s.status === "fulfilled") setStats(s.value);
      if (a.status === "fulfilled") setActivity(a.value.data ?? []);
>>>>>>> origin/main
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, []);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.primary} onRefresh={() => { setRefreshing(true); load(true); }} />}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Header gradient ─────────────────────────────── */}
      <LinearGradient colors={["#4F46E5", "#7C3AED"]} style={styles.header}>
        <View style={styles.headerTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.greet}>{greet()},</Text>
            <Text style={styles.userName} numberOfLines={1}>{user?.name ?? "—"}</Text>
            <Text style={styles.userRole}>{user?.role ?? ""}</Text>
          </View>
          <Avatar name={user?.name ?? "U"} size={48} style={{ borderWidth: 2, borderColor: "rgba(255,255,255,0.4)" }} />
        </View>

        {/* My today card */}
        <View style={styles.todayCard}>
          <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
            <View style={{ alignItems: "center" }}>
              <Text style={styles.todayLabel}>Check-in</Text>
<<<<<<< HEAD
              <Text style={styles.todayVal}>{today?.checkIn ? new Date(today.checkIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—:——"}</Text>
=======
              <Text style={styles.todayVal}>{stats?.myCheckin ? new Date(stats.myCheckin).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—:——"}</Text>
>>>>>>> origin/main
            </View>
            <View style={styles.todayDivider} />
            <View style={{ alignItems: "center" }}>
              <Text style={styles.todayLabel}>Check-out</Text>
<<<<<<< HEAD
              <Text style={styles.todayVal}>{today?.checkOut ? new Date(today.checkOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—:——"}</Text>
=======
              <Text style={styles.todayVal}>{stats?.myCheckout ? new Date(stats.myCheckout).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—:——"}</Text>
>>>>>>> origin/main
            </View>
            <View style={styles.todayDivider} />
            <View style={{ alignItems: "center" }}>
              <Text style={styles.todayLabel}>Leave Bal.</Text>
<<<<<<< HEAD
              <Text style={styles.todayVal}>{stats?.casualRemaining ?? "—"}</Text>
=======
              <Text style={styles.todayVal}>{stats?.myLeaveBalance ?? "—"}</Text>
>>>>>>> origin/main
            </View>
          </View>
        </View>
      </LinearGradient>

      <View style={styles.body}>
<<<<<<< HEAD
        {/* ── Stats row (this month, from ess.dashboard) ── */}
        <View style={{ flexDirection: "row", gap: Spacing.sm }}>
          <StatChip value={stats?.attendance?.present ?? "—"} label="Present" color={Colors.success} />
          <StatChip value={stats?.attendance?.absent  ?? "—"} label="Absent"  color={Colors.danger}  />
          <StatChip value={stats?.attendance?.late    ?? "—"} label="Late"    color={Colors.warning} />
          <StatChip value={stats?.openTasks ?? "—"} label="Tasks" color={Colors.primary} />
=======
        {/* ── Stats row ─────────────────────────────────── */}
        <View style={{ flexDirection: "row", gap: Spacing.sm }}>
          <StatChip value={stats?.presentToday ?? "—"} label="Present" color={Colors.success} />
          <StatChip value={stats?.absentToday  ?? "—"} label="Absent"  color={Colors.danger}  />
          <StatChip value={stats?.lateToday    ?? "—"} label="Late"    color={Colors.warning} />
          <StatChip value={stats?.pendingLeaves ?? "—"} label="Pending" color={Colors.primary} />
>>>>>>> origin/main
        </View>

        {/* ── Quick actions ─────────────────────────────── */}
        <View style={{ marginTop: Spacing.xl }}>
          <SectionHeader title="Quick Actions" />
          <View style={styles.quickGrid}>
            {QUICK_ACTIONS.map(a => (
              <TouchableOpacity key={a.label} style={styles.quickItem} activeOpacity={0.78}
                onPress={() => router.push(a.route as any)}>
                <View style={[styles.quickIcon, { backgroundColor: a.color + "18" }]}>
                  <Ionicons name={a.icon as any} size={22} color={a.color} />
                </View>
                <Text style={styles.quickLabel}>{a.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── Recent notifications ───────────────────────── */}
        <View style={{ marginTop: Spacing.xl, gap: Spacing.md }}>
          <SectionHeader title="Recent Activity" action="See all" />
          {activity.length === 0 ? (
            <Card><EmptyState icon="🔔" title="No notifications" subtitle="You're all caught up!" /></Card>
          ) : (
            activity.map(n => (
              <Card key={n.id} style={{ flexDirection: "row", gap: Spacing.md, padding: Spacing.md }}>
<<<<<<< HEAD
                <View style={[styles.actDot, { backgroundColor: n.readAt ? Colors.border : Colors.primary }]} />
=======
                <View style={[styles.actDot, { backgroundColor: n.read ? Colors.border : Colors.primary }]} />
>>>>>>> origin/main
                <View style={{ flex: 1 }}>
                  <Text style={Typography.h4} numberOfLines={1}>{n.title}</Text>
                  <Text style={[Typography.bodyS, { marginTop: 2 }]} numberOfLines={2}>{n.message}</Text>
                  <Text style={[Typography.caption, { marginTop: 4 }]}>
                    {new Date(n.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
              </Card>
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: Platform.OS === "ios" ? 60 : (StatusBar.currentHeight ?? 0) + 16,
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xxl + 16,
  },
  headerTop: { flexDirection: "row", alignItems: "flex-start", marginBottom: Spacing.lg },
  greet:     { color: "rgba(255,255,255,0.75)", fontSize: 13, fontWeight: "500" },
  userName:  { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: 2 },
  userRole:  { color: "rgba(255,255,255,0.65)", fontSize: 12, marginTop: 3 },
  todayCard: {
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  todayLabel:   { color: "rgba(255,255,255,0.7)", fontSize: 11, fontWeight: "600" },
  todayVal:     { color: "#fff", fontSize: 18, fontWeight: "700", marginTop: 4 },
  todayDivider: { width: 1, backgroundColor: "rgba(255,255,255,0.2)", marginVertical: 4 },
  body: { padding: Spacing.lg, paddingTop: Spacing.lg, gap: 0 },
  quickGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm, marginTop: Spacing.md },
  quickItem: { width: "30%", alignItems: "center", gap: 6 },
  quickIcon: { width: 52, height: 52, borderRadius: 16, justifyContent: "center", alignItems: "center" },
  quickLabel:{ fontSize: 11, fontWeight: "600", color: Colors.textSecondary, textAlign: "center" },
  actDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
});

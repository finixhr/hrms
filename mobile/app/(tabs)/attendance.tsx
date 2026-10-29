// Attendance screen — polished GPS check-in/out, today card, weekly summary

import { useState, useCallback, useEffect } from "react";
import {
  View, Text, ScrollView, RefreshControl, StyleSheet,
  Platform, StatusBar, TouchableOpacity, Alert,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { rpc, ApiError } from "@/src/lib/api";
import { getCurrentLocation } from "@/src/lib/location";
import { Card, Button, Badge, SectionHeader, EmptyState, StatChip } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius, Shadow } from "@/src/theme";

interface AttRecord {
  id?: string;
  checkIn?: string | null;
  checkOut?: string | null;
  status?: string;
  date?: string;
  workingMinutes?: number;
  overtimeMinutes?: number;
}

interface WeekRow {
  date: string;
  status: string;
  checkIn?: string | null;
  checkOut?: string | null;
  workingMinutes?: number;
}

function fmt(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function mins2h(m?: number) {
  if (!m) return "0h 0m";
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function AttendanceScreen() {
  const [today, setToday]       = useState<AttRecord | null>(null);
  const [week, setWeek]         = useState<WeekRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [locating, setLocating] = useState(false);

  const load = useCallback(async (silent = false) => {
    try {
      const [t, w] = await Promise.allSettled([
        rpc<AttRecord>("attendance.today", {}),
        rpc<{ data: WeekRow[] }>("attendance.myWeek", {}),
      ]);
      if (t.status === "fulfilled") setToday(t.value);
      if (w.status === "fulfilled") setWeek(w.value.data ?? []);
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, []);

  const handleCheckin = useCallback(async () => {
    setLocating(true);
    const loc = await getCurrentLocation().finally(() => setLocating(false));
    if (!loc) { Alert.alert("Location Required", "Enable location access to check in."); return; }
    setActionLoading(true);
    try {
      const d = await rpc<AttRecord>("attendance.selfCheckin", { latitude: loc.latitude, longitude: loc.longitude });
      setToday(d);
    } catch (e) { Alert.alert("Error", e instanceof ApiError ? e.message : "Check-in failed"); }
    finally { setActionLoading(false); }
  }, []);

  const handleCheckout = useCallback(async () => {
    setActionLoading(true);
    try {
      const loc = await getCurrentLocation();
      const d = await rpc<AttRecord>("attendance.selfCheckout", { latitude: loc?.latitude, longitude: loc?.longitude });
      setToday(d);
    } catch (e) { Alert.alert("Error", e instanceof ApiError ? e.message : "Check-out failed"); }
    finally { setActionLoading(false); }
  }, []);

  const alreadyIn  = Boolean(today?.checkIn);
  const alreadyOut = Boolean(today?.checkOut);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.primary} onRefresh={() => { setRefreshing(true); load(true); }} />}
    >
      {/* Header */}
      <LinearGradient colors={["#4F46E5", "#06B6D4"]} style={styles.header}>
        <Text style={styles.headerTitle}>Attendance</Text>
        <Text style={styles.headerSub}>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</Text>

        {/* Today card */}
        <View style={styles.todayCard}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: Spacing.md }}>
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>Today</Text>
            {today?.status && <Badge label={today.status} />}
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
            <View style={{ alignItems: "center" }}>
              <Ionicons name="log-in-outline" size={20} color="rgba(255,255,255,0.8)" />
              <Text style={styles.tlabel}>Check-in</Text>
              <Text style={styles.tval}>{fmt(today?.checkIn)}</Text>
            </View>
            <View style={styles.vDivider} />
            <View style={{ alignItems: "center" }}>
              <Ionicons name="log-out-outline" size={20} color="rgba(255,255,255,0.8)" />
              <Text style={styles.tlabel}>Check-out</Text>
              <Text style={styles.tval}>{fmt(today?.checkOut)}</Text>
            </View>
            <View style={styles.vDivider} />
            <View style={{ alignItems: "center" }}>
              <Ionicons name="timer-outline" size={20} color="rgba(255,255,255,0.8)" />
              <Text style={styles.tlabel}>Hours</Text>
              <Text style={styles.tval}>{mins2h(today?.workingMinutes)}</Text>
            </View>
          </View>
        </View>
      </LinearGradient>

      <View style={styles.body}>
        {/* Action button */}
        {alreadyOut ? (
          <View style={styles.doneRow}>
            <Ionicons name="checkmark-circle" size={22} color={Colors.success} />
            <Text style={{ color: Colors.success, fontWeight: "700", fontSize: 15 }}>Attendance complete for today</Text>
          </View>
        ) : !alreadyIn ? (
          <Button
            label={locating ? "Getting Location…" : actionLoading ? "Checking in…" : "📍  Check In"}
            onPress={handleCheckin}
            variant="primary"
            size="lg"
            loading={actionLoading || locating}
            fullWidth
          />
        ) : (
          <Button
            label={actionLoading ? "Checking out…" : "📍  Check Out"}
            onPress={handleCheckout}
            variant="danger"
            size="lg"
            loading={actionLoading}
            fullWidth
          />
        )}

        {/* Weekly summary */}
        <View style={{ marginTop: Spacing.xl, gap: Spacing.md }}>
          <SectionHeader title="This Week" />
          {week.length === 0 ? (
            <Card><EmptyState icon="📅" title="No records this week" /></Card>
          ) : (
            week.map(r => (
              <Card key={r.date} style={{ flexDirection: "row", alignItems: "center", gap: Spacing.md, padding: Spacing.md }}>
                <View style={[styles.dayCircle, { backgroundColor: Colors.primary + "15" }]}>
                  <Text style={{ color: Colors.primary, fontWeight: "700", fontSize: 11 }}>
                    {new Date(r.date).toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={Typography.h4}>{new Date(r.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Text>
                  <Text style={Typography.bodyS}>{fmt(r.checkIn)} – {fmt(r.checkOut)}</Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Badge label={r.status ?? "—"} />
                  <Text style={Typography.caption}>{mins2h(r.workingMinutes)}</Text>
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
    paddingBottom: Spacing.xxl,
  },
  headerTitle: { color: "#fff", fontSize: 24, fontWeight: "800" },
  headerSub:   { color: "rgba(255,255,255,0.7)", fontSize: 13, marginTop: 2, marginBottom: Spacing.lg },
  todayCard: {
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  tlabel: { color: "rgba(255,255,255,0.65)", fontSize: 11, marginTop: 4 },
  tval:   { color: "#fff", fontWeight: "700", fontSize: 17, marginTop: 2 },
  vDivider: { width: 1, backgroundColor: "rgba(255,255,255,0.2)", marginVertical: 4 },
  body: { padding: Spacing.lg, gap: 0 },
  doneRow: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    backgroundColor: Colors.successLight, borderRadius: Radius.lg,
    padding: Spacing.lg, justifyContent: "center",
  },
  dayCircle: { width: 44, height: 44, borderRadius: 12, justifyContent: "center", alignItems: "center" },
});

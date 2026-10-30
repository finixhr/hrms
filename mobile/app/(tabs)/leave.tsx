// Leave screen — beautiful apply form, balance chips, request list

import { useState, useCallback, useEffect } from "react";
import {
  View, Text, ScrollView, RefreshControl, StyleSheet,
  Platform, StatusBar, Alert, TouchableOpacity,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { rpc, ApiError } from "@/src/lib/api";
import { Card, Button, Badge, Input, SectionHeader, EmptyState } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface LeaveType   { id: string; name: string; code?: string; active?: boolean }
// ess.leave contract (src/hrm-server/routes/ess.ts:81):
//   { balances: [{ leaveTypeId, typeName, remaining, … }],
//     types: LeaveType[],
//     requests: [{ id, fromDate, toDate, typeName, status, reason, … }] }
interface LeaveReq    { id: string; typeName?: string; fromDate: string; toDate: string; status: string; reason?: string }
interface LeaveBalance { leaveTypeId: string; typeName: string; remaining: number; used?: number; entitled?: number }

export default function LeaveScreen() {
  const [types, setTypes]       = useState<LeaveType[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [requests, setRequests] = useState<LeaveReq[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [selType, setSelType]   = useState("");
  const [start, setStart]       = useState("");
  const [end, setEnd]           = useState("");
  const [reason, setReason]     = useState("");

  const load = useCallback(async (_silent = false) => {
    try {
      // One self-scoped call replaces the three broken ones: balances +
      // types + my request history (server: ess.leave, routes/ess.ts:81).
      const res = await rpc<{ balances: LeaveBalance[]; types: LeaveType[]; requests: LeaveReq[] }>("ess.leave", {});
      setBalances(res?.balances ?? []);
      setTypes(res?.types ?? []);
      setRequests(res?.requests ?? []);
      if (!selType && res?.types?.length) setSelType(res.types[0].id);
    } finally { setRefreshing(false); }
  }, [selType]);

  useEffect(() => { load(); }, []);

  const submit = useCallback(async () => {
    if (!selType || !start || !end || !reason.trim()) { Alert.alert("Required", "Please fill in all fields."); return; }
    setSubmitting(true);
    try {
      // Server schema S.leaveApply (validation.ts:225) requires fromDate/toDate.
      await rpc("leaveRequests.apply", { leaveTypeId: selType, fromDate: start, toDate: end, reason });
      setShowForm(false); setReason(""); setStart(""); setEnd("");
      load(true);
    } catch (e) { Alert.alert("Error", e instanceof ApiError ? e.message : "Submission failed"); }
    finally { setSubmitting(false); }
  }, [selType, start, end, reason, load]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.success} onRefresh={() => { setRefreshing(true); load(true); }} />}
    >
      {/* Header */}
      <LinearGradient colors={["#10B981", "#059669"]} style={styles.header}>
        <Text style={styles.headerTitle}>Leave</Text>
        <Text style={styles.headerSub}>Manage your leave requests</Text>
        {/* Balance pills */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: Spacing.md }}>
          {balances.map(b => (
            <View key={b.leaveTypeId} style={styles.balPill}>
              <Text style={styles.balVal}>{b.remaining}</Text>
              <Text style={styles.balLabel}>{b.typeName}</Text>
            </View>
          ))}
          {balances.length === 0 && types.map(t => (
            <View key={t.id} style={styles.balPill}>
              <Text style={styles.balVal}>—</Text>
              <Text style={styles.balLabel}>{t.name}</Text>
            </View>
          ))}
        </ScrollView>
      </LinearGradient>

      <View style={styles.body}>
        {/* Apply button toggle */}
        <Button
          label={showForm ? "✕  Cancel" : "+ Apply for Leave"}
          onPress={() => setShowForm(v => !v)}
          variant={showForm ? "ghost" : "success"}
          fullWidth
          size="lg"
        />

        {/* Apply form */}
        {showForm && (
          <Card style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            <Text style={Typography.h3}>New Leave Request</Text>

            <View>
              <Text style={[Typography.label, { marginBottom: 6 }]}>Leave Type</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {types.map(t => (
                  <TouchableOpacity key={t.id} onPress={() => setSelType(t.id)}
                    style={[styles.typeChip, selType === t.id && styles.typeChipSel]}>
                    <Text style={[styles.typeChipText, selType === t.id && { color: "#fff" }]}>{t.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View style={{ flexDirection: "row", gap: Spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Input label="Start Date" value={start} onChangeText={setStart} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
              </View>
              <View style={{ flex: 1 }}>
                <Input label="End Date" value={end} onChangeText={setEnd} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
              </View>
            </View>

            <Input
              label="Reason"
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={3}
              placeholder="Briefly describe your reason…"
              style={{ height: 90 } as any}
            />

            <Button label="Submit Request" onPress={submit} loading={submitting} variant="success" fullWidth />
          </Card>
        )}

        {/* Request list */}
        <View style={{ marginTop: Spacing.xl, gap: Spacing.md }}>
          <SectionHeader title="My Requests" />
          {requests.length === 0 ? (
            <Card><EmptyState icon="🌴" title="No leave requests" subtitle="Apply for leave to see them here" /></Card>
          ) : (
            requests.map(r => (
              <Card key={r.id}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={Typography.h4}>{r.typeName ?? "Leave"}</Text>
                    <Text style={[Typography.bodyS, { marginTop: 2 }]}>
                      {r.fromDate} → {r.toDate}
                    </Text>
                    <Text style={[Typography.bodyS, { marginTop: 4 }]} numberOfLines={2}>{r.reason}</Text>
                  </View>
                  <Badge label={r.status} style={{ marginLeft: Spacing.sm }} />
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
  headerSub:   { color: "rgba(255,255,255,0.75)", fontSize: 13, marginTop: 2 },
  balPill: {
    backgroundColor: "rgba(255,255,255,0.18)", borderRadius: Radius.lg,
    padding: Spacing.md, alignItems: "center", marginRight: Spacing.sm,
    minWidth: 72, borderWidth: 1, borderColor: "rgba(255,255,255,0.22)",
  },
  balVal:   { color: "#fff", fontSize: 20, fontWeight: "800" },
  balLabel: { color: "rgba(255,255,255,0.75)", fontSize: 10, fontWeight: "600", marginTop: 2, textAlign: "center" },
  body: { padding: Spacing.lg, gap: 0 },
  typeChip: {
    borderWidth: 1.5, borderColor: Colors.border, borderRadius: Radius.full,
    paddingHorizontal: 14, paddingVertical: 8, marginRight: 8,
    backgroundColor: Colors.surface,
  },
  typeChipSel:  { backgroundColor: Colors.success, borderColor: Colors.success },
  typeChipText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
});

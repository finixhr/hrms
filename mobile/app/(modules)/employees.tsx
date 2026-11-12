// Employee directory screen — searchable, filterable, with avatars

import { useState } from "react";
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  Platform, StatusBar, RefreshControl,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFetch } from "@/src/hooks/useFetch";
import { Avatar, Badge, EmptyState, Card } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

// Employee directory screen — searchable colleague list.
//
// SERVER CONTRACT (verified 2026-10-30): ess.colleagues (routes/ess.ts:170,
// perm ess.view) returns a BARE ARRAY of { id, fullName, code, designationName,
// departmentName, branchName, sameBranch, sameDepartment } — names + org
// context only, by design (no sensitive employee data). The old call used
// employees.list, which is the permission-gated HR plane with PII masking.

interface Colleague {
  id: string; code: string; fullName: string;
  designationName?: string | null; departmentName?: string | null;
  branchName?: string | null; sameBranch?: boolean; sameDepartment?: boolean;
}

export default function EmployeesScreen() {
  const [q, setQ] = useState("");
  const { data, loading, refreshing, refresh } = useFetch<Colleague[]>("ess.colleagues", {});

  const list = (data ?? []).filter(e =>
    !q || e.fullName.toLowerCase().includes(q.toLowerCase()) ||
    e.code.toLowerCase().includes(q.toLowerCase()) ||
    (e.designationName ?? "").toLowerCase().includes(q.toLowerCase()) ||
    (e.departmentName ?? "").toLowerCase().includes(q.toLowerCase())
  );

  return (
    <View style={{ flex: 1, backgroundColor: Colors.background }}>
      <LinearGradient colors={["#4F46E5", "#6366F1"]} style={styles.header}>
        <Text style={styles.title}>Directory</Text>
        <Text style={styles.sub}>{data?.length ?? "—"} colleagues</Text>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={16} color={Colors.textTertiary} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name, code, role…"
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={q}
            onChangeText={setQ}
          />
          {q ? <TouchableOpacity onPress={() => setQ("")}><Ionicons name="close-circle" size={16} color="rgba(255,255,255,0.6)" /></TouchableOpacity> : null}
        </View>
      </LinearGradient>

      <FlatList
        data={list}
        keyExtractor={e => e.id}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.primary} onRefresh={refresh} />}
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.sm }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          loading ? null : <Card><EmptyState icon="👥" title="No employees found" /></Card>
        }
        renderItem={({ item: emp }) => (
          <Card style={styles.empRow}>
            <Avatar name={emp.fullName} size={46} />
            <View style={{ flex: 1, marginLeft: Spacing.md }}>
              <Text style={Typography.h4} numberOfLines={1}>{emp.fullName}</Text>
              <Text style={Typography.bodyS} numberOfLines={1}>
                {emp.designationName ?? "—"}{emp.departmentName ? ` · ${emp.departmentName}` : ""}
              </Text>
              <Text style={[Typography.caption, { marginTop: 2 }]}>
                {emp.code}{emp.branchName ? ` · ${emp.branchName}` : ""}
              </Text>
            </View>
            {emp.sameDepartment ? <Badge label="My Dept" /> : emp.sameBranch ? <Badge label="My Branch" /> : null}
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: Platform.OS === "ios" ? 60 : (StatusBar.currentHeight ?? 0) + 16,
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xl,
  },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub:   { color: "rgba(255,255,255,0.75)", fontSize: 13, marginTop: 2, marginBottom: Spacing.md },
  searchBar: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.15)", borderRadius: Radius.md,
    paddingHorizontal: Spacing.md, paddingVertical: 10,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.22)",
  },
  searchInput: { flex: 1, color: "#fff", fontSize: 15 },
  empRow: { flexDirection: "row", alignItems: "center" },
});

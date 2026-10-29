// Employee directory screen — searchable, filterable, with avatars

import { useState, useCallback } from "react";
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  Platform, StatusBar, RefreshControl,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFetch } from "@/src/hooks/useFetch";
import { Avatar, Badge, EmptyState, Card } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface Employee {
  id: string; code: string; fullName: string; designation?: string;
  department?: string; status: string; email?: string; phone?: string;
}

export default function EmployeesScreen() {
  const [q, setQ] = useState("");
  const { data, loading, refreshing, refresh } = useFetch<{ data: Employee[] }>(
    "employees.list", { page: 1, limit: 50 }
  );

  const list = (data?.data ?? []).filter(e =>
    !q || e.fullName.toLowerCase().includes(q.toLowerCase()) ||
    e.code.toLowerCase().includes(q.toLowerCase()) ||
    (e.designation ?? "").toLowerCase().includes(q.toLowerCase())
  );

  return (
    <View style={{ flex: 1, backgroundColor: Colors.background }}>
      <LinearGradient colors={["#4F46E5", "#6366F1"]} style={styles.header}>
        <Text style={styles.title}>Employees</Text>
        <Text style={styles.sub}>{data?.data?.length ?? "—"} members</Text>
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
                {emp.designation ?? "—"}{emp.department ? ` · ${emp.department}` : ""}
              </Text>
              <Text style={[Typography.caption, { marginTop: 2 }]}>{emp.code}</Text>
            </View>
            <Badge label={emp.status} />
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

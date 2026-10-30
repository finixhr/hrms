// Support / Help Desk screen — view tickets, create new, chat

import { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Platform, StatusBar, RefreshControl, Alert,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useFetch } from "@/src/hooks/useFetch";
import { rpc, ApiError } from "@/src/lib/api";
import { Card, Badge, Button, EmptyState, SectionHeader, Input } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface Ticket {
  // support.tickets contract (routes/support.ts:133) — { rows: [...] }
  id: string; number: number; subject: string; category: string; status: string; priority: string;
  assigneeName?: string | null; lastMessageAt?: string | null; createdAt: string; closedAt?: string | null;
}

// Server enum: LOW | NORMAL | HIGH | URGENT (routes/support.ts:203). There is
// no "MEDIUM" — the old screen offered it and every such submission failed
// the .strict() schema.
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

const CATEGORIES = ["GENERAL", "BILLING", "ATTENDANCE", "PAYROLL", "LEAVE", "EMPLOYEES", "RECRUITMENT", "REPORTS", "SECURITY", "DATA", "INTEGRATION", "OTHER"] as const;

export default function SupportScreen() {
  const { data, refreshing, refresh } = useFetch<{ rows: Ticket[] }>("support.tickets", { status: "ALL", take: 50 });
  const tickets = data?.rows ?? [];
  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject]   = useState("");
  const [message, setMessage]   = useState("");
  const [category, setCategory] = useState<string>("GENERAL");
  const [priority, setPriority] = useState<string>("NORMAL");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!subject.trim() || message.trim().length < 10) {
      Alert.alert("Required", "Please fill in the subject and a message of at least 10 characters.");
      return;
    }
    setSubmitting(true);
    try {
      // Server schema (routes/support.ts:200, .strict()): subject 4–160,
      // category enum, priority enum, message 10–5000. The old call used the
      // wrong action name, `body` instead of `message`, and a "MEDIUM"
      // priority that does not exist.
      await rpc("support.ticket.create", { subject: subject.trim(), category, priority, message: message.trim() });
      setShowForm(false); setSubject(""); setMessage(""); setCategory("GENERAL"); setPriority("NORMAL");
      refresh();
    } catch (e) { Alert.alert("Error", e instanceof ApiError ? e.message : "Failed to create ticket"); }
    finally { setSubmitting(false); }
  };

  const priorityColor: Record<string, string> = {
    LOW: Colors.success, NORMAL: Colors.warning, HIGH: Colors.danger, URGENT: "#7C3AED",
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.info} onRefresh={refresh} />}
    >
      <LinearGradient colors={["#2563EB", "#1D4ED8"]} style={styles.header}>
        <Text style={styles.title}>Help & Support</Text>
        <Text style={styles.sub}>Raise issues · Get help · Track tickets</Text>
      </LinearGradient>

      <View style={styles.body}>
        <Button
          label={showForm ? "✕  Cancel" : "+ New Support Ticket"}
          onPress={() => setShowForm(v => !v)}
          variant={showForm ? "ghost" : "primary"}
          fullWidth size="lg"
        />

        {showForm && (
          <Card style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            <Text style={Typography.h3}>New Ticket</Text>
            <Input label="Subject" value={subject} onChangeText={setSubject} placeholder="Brief description of the issue" />

            <View>
              <Text style={[Typography.label, { marginBottom: 6 }]}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {CATEGORIES.map(c => (
                  <TouchableOpacity key={c} onPress={() => setCategory(c)}
                    style={[styles.priChip, { borderColor: Colors.border }, category === c && { backgroundColor: Colors.primary, borderColor: Colors.primary }]}>
                    <Text style={[styles.priChipText, { color: category === c ? "#fff" : Colors.textSecondary }]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View>
              <Text style={[Typography.label, { marginBottom: 6 }]}>Priority</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {PRIORITIES.map(p => (
                  <TouchableOpacity key={p} onPress={() => setPriority(p)}
                    style={[styles.priChip, { borderColor: priorityColor[p] }, priority === p && { backgroundColor: priorityColor[p] }]}>
                    <Text style={[styles.priChipText, { color: priority === p ? "#fff" : priorityColor[p] }]}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <Input
              label="Message"
              value={message}
              onChangeText={setMessage}
              multiline
              numberOfLines={4}
              placeholder="Describe the issue in detail (at least 10 characters)…"
            />
            <Button label="Submit Ticket" onPress={submit} loading={submitting} variant="primary" fullWidth />
          </Card>
        )}

        <SectionHeader title="My Tickets" style={styles.section} />
        {tickets.length === 0
          ? <Card><EmptyState icon="🎧" title="No tickets yet" subtitle="Create a ticket when you need help" /></Card>
          : tickets.map(t => (
            <Card key={t.id} style={styles.ticketCard}>
              <View style={styles.ticketTop}>
                <View style={[styles.priDot, { backgroundColor: priorityColor[t.priority] ?? Colors.info }]} />
                <Text style={[Typography.h4, { flex: 1 }]} numberOfLines={1}>#{t.number} · {t.subject}</Text>
                <Badge label={t.status} />
              </View>
              {t.assigneeName ? (
                <Text style={[Typography.bodyS, { marginTop: 6 }]}>Handled by {t.assigneeName}</Text>
              ) : null}
              <View style={styles.ticketFooter}>
                <Text style={Typography.caption}>
                  {t.category} · {new Date(t.lastMessageAt ?? t.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </Text>
                <View style={[styles.priLabel, { backgroundColor: (priorityColor[t.priority] ?? Colors.info) + "20" }]}>
                  <Text style={[styles.priLabelText, { color: priorityColor[t.priority] ?? Colors.info }]}>{t.priority}</Text>
                </View>
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
  sub:   { color: "rgba(255,255,255,0.75)", fontSize: 13, marginTop: 2 },
  body:  { padding: Spacing.lg },
  section: { marginTop: Spacing.xl, marginBottom: Spacing.md },
  priChip: {
    borderWidth: 1.5, borderRadius: Radius.full, paddingHorizontal: 14,
    paddingVertical: 7, marginRight: 8,
  },
  priChipText: { fontSize: 12, fontWeight: "700" },
  ticketCard: { marginBottom: Spacing.sm },
  ticketTop: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  priDot: { width: 8, height: 8, borderRadius: 4 },
  ticketFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: Spacing.sm },
  priLabel: { borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  priLabelText: { fontSize: 10, fontWeight: "700" },
});

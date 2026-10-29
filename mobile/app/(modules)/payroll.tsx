// Payroll screen — my payslips, net pay chart, native download & share

import { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, StatusBar, RefreshControl, Alert,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useFetch } from "@/src/hooks/useFetch";
import { rpc } from "@/src/lib/api";
import { Card, Badge, EmptyState, SectionHeader } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface PayslipItem {
  entryId: string;
  payslipNumber: string;
  period: string;
  paidOn?: string;
  gross: number;
  net: number;
  ait: number;
  breakdown?: Record<string, unknown>;
}

interface EssPayrollData {
  payslips: PayslipItem[];
  totalAit: number;
}

function currency(n?: number) {
  if (n == null) return "—";
  return "৳" + n.toLocaleString("en-BD", { maximumFractionDigits: 0 });
}

export default function PayrollScreen() {
  const { data, loading, refreshing, refresh } = useFetch<EssPayrollData>("ess.payroll", {});
  const [downloading, setDownloading] = useState<string | null>(null);

  const list = data?.payslips ?? [];
  const latest = list[0];
  const totalAit = data?.totalAit ?? 0;

  const handleDownload = async (slip: PayslipItem) => {
    setDownloading(slip.entryId);
    try {
      const res = await rpc<{ html: string }>("ess.payroll.html", { entryId: slip.entryId });
      if (!res?.html) throw new Error("Payslip HTML content not available");

      const filename = `payslip_${slip.payslipNumber || slip.entryId}.html`;
      const filePath = `${FileSystem.documentDirectory}${filename}`;

      await FileSystem.writeAsStringAsync(filePath, res.html, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(filePath, {
          mimeType: "text/html",
          dialogTitle: `Share Payslip ${slip.payslipNumber || slip.period}`,
        });
      } else {
        Alert.alert("Downloaded", `Payslip saved as ${filename}`);
      }
    } catch (err: any) {
      Alert.alert("Download Error", err?.message || "Could not download payslip.");
    } finally {
      setDownloading(null);
    }
  };

  const ytdGross = list.reduce((acc, p) => acc + (p.gross || 0), 0);
  const ytdNet = list.reduce((acc, p) => acc + (p.net || 0), 0);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.warning} onRefresh={refresh} />}
    >
      {/* Header */}
      <LinearGradient colors={["#F59E0B", "#F97316"]} style={styles.header}>
        <Text style={styles.title}>Payroll</Text>
        <Text style={styles.sub}>Your earnings & payslips</Text>

        {/* Latest pay card */}
        {latest && (
          <View style={styles.payCard}>
            <Text style={styles.payCardLabel}>Last Net Pay · {latest.period}</Text>
            <Text style={styles.payCardAmt}>{currency(latest.net)}</Text>
            <View style={styles.payCardRow}>
              <View style={{ alignItems: "center" }}>
                <Text style={styles.payCardSubLabel}>Gross</Text>
                <Text style={styles.payCardSubVal}>{currency(latest.gross)}</Text>
              </View>
              <View style={styles.vDiv} />
              <View style={{ alignItems: "center" }}>
                <Text style={styles.payCardSubLabel}>Tax (AIT)</Text>
                <Text style={styles.payCardSubVal}>{currency(latest.ait)}</Text>
              </View>
              <View style={styles.vDiv} />
              <View style={{ alignItems: "center" }}>
                <Text style={styles.payCardSubLabel}>Slip No.</Text>
                <Badge label={latest.payslipNumber || "PAID"} style={{ marginTop: 4 }} />
              </View>
            </View>
          </View>
        )}
      </LinearGradient>

      <View style={styles.body}>
        {/* YTD summary chips */}
        {list.length > 0 && (
          <View style={styles.ytdRow}>
            {[
              { label: "Total Gross", value: currency(ytdGross), color: Colors.warning },
              { label: "Total Net",   value: currency(ytdNet),   color: Colors.success },
              { label: "Total Tax",   value: currency(totalAit), color: Colors.danger  },
            ].map(c => (
              <View key={c.label} style={[styles.ytdChip, { borderLeftColor: c.color }]}>
                <Text style={[styles.ytdVal, { color: c.color }]}>{c.value}</Text>
                <Text style={styles.ytdLabel}>{c.label}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Payslip list */}
        <SectionHeader title="Payslip History" style={{ marginTop: Spacing.lg, marginBottom: Spacing.md }} />

        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} style={styles.skeletonCard}>
              <View style={styles.skelRow}>
                <View style={styles.skelBlock} />
                <View style={[styles.skelBlock, { width: 80 }]} />
              </View>
            </Card>
          ))
        ) : list.length === 0 ? (
          <Card><EmptyState icon="💰" title="No payslips yet" subtitle="Payslips appear here once payroll is processed" /></Card>
        ) : (
          list.map(slip => (
            <Card key={slip.entryId} style={styles.slipCard}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={styles.monthCircle}>
                  <Ionicons name="document-text-outline" size={22} color={Colors.warning} />
                </View>
                <View style={{ flex: 1, marginLeft: Spacing.md }}>
                  <Text style={Typography.h4}>{slip.period}</Text>
                  <Text style={Typography.bodyS}>Net: <Text style={{ fontWeight: "700", color: Colors.success }}>{currency(slip.net)}</Text></Text>
                  <Text style={[Typography.caption, { marginTop: 2 }]}>Gross {currency(slip.gross)} · Tax {currency(slip.ait)}</Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 8 }}>
                  <Badge label={slip.payslipNumber || "PAID"} />
                  <TouchableOpacity
                    style={styles.dlBtn}
                    onPress={() => handleDownload(slip)}
                    disabled={downloading === slip.entryId}
                  >
                    <Ionicons name={downloading === slip.entryId ? "hourglass-outline" : "download-outline"} size={16} color={Colors.primary} />
                  </TouchableOpacity>
                </View>
              </View>
            </Card>
          ))
        )}
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
  payCard: {
    backgroundColor: "rgba(255,255,255,0.15)", borderRadius: Radius.lg,
    padding: Spacing.lg, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)",
  },
  payCardLabel: { color: "rgba(255,255,255,0.75)", fontSize: 12, fontWeight: "600" },
  payCardAmt:   { color: "#fff", fontSize: 36, fontWeight: "800", marginVertical: 6 },
  payCardRow:   { flexDirection: "row", justifyContent: "space-around", marginTop: 4 },
  payCardSubLabel: { color: "rgba(255,255,255,0.65)", fontSize: 11 },
  payCardSubVal:   { color: "#fff", fontWeight: "700", fontSize: 14, marginTop: 3 },
  vDiv: { width: 1, backgroundColor: "rgba(255,255,255,0.2)", marginVertical: 2 },
  body: { padding: Spacing.lg },
  ytdRow: { flexDirection: "row", gap: Spacing.sm },
  ytdChip: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: Radius.md,
    padding: Spacing.md, borderLeftWidth: 3,
    ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }, android: { elevation: 2 } }),
  },
  ytdVal:   { fontSize: 16, fontWeight: "800" },
  ytdLabel: { fontSize: 10, color: Colors.textTertiary, marginTop: 2, fontWeight: "600" },
  slipCard: { marginBottom: Spacing.sm },
  monthCircle: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: Colors.warningLight, alignItems: "center", justifyContent: "center",
  },
  dlBtn: {
    width: 32, height: 32, borderRadius: 8, backgroundColor: Colors.primaryLight,
    justifyContent: "center", alignItems: "center",
  },
  skeletonCard: { marginBottom: Spacing.sm, height: 72 },
  skelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  skelBlock: { height: 16, backgroundColor: Colors.border, borderRadius: 8, flex: 1, marginHorizontal: 4 },
});

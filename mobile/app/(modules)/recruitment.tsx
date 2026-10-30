// Recruitment screen — open positions and the ATS pipeline.
//
// SERVER CONTRACTS (verified 2026-10-30):
//   recruitment.openings.list    (routes/recruitment.ts:97)  — perm recruitment.view,
//     schema { status? }, returns a bare array of opening rows (title, departmentName,
//     branchName, employmentType, openings, deadline, status, applicationCount).
//   recruitment.applications.list (routes/recruitment.ts:216) — perm recruitment.view,
//     returns rows with openingTitle, status, createdAt, masked candidate contact
//     (masking lifts only for recruitment.edit holders).
// There are NO `recruitment.openJobs` / `recruitment.myApplications` /
// `recruitment.stats` actions — job applications belong to external candidates
// on the public careers site, not to internal employees, so this screen is an
// HR/manager view (the Modules hub gates it behind the recruitment.view
// permission).

import {
  View, Text, ScrollView, StyleSheet,
  Platform, StatusBar, RefreshControl,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFetch } from "@/src/hooks/useFetch";
import { Card, Badge, EmptyState, SectionHeader, StatChip } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface JobOpening {
  id: string;
  title: string;
  departmentName?: string | null;
  branchName?: string | null;
  employmentType: string;
  openings: number;
  deadline?: string | null;
  status: string;
  applicationCount: number;
}

interface JobApplication {
  id: string;
  openingTitle?: string;
  status: string;
  createdAt: string;
  candidateName?: string;
}

export default function RecruitmentScreen() {
  const { data: jobs, refreshing: r1, refresh: re1 } = useFetch<JobOpening[]>("recruitment.openings.list", {});
  const { data: apps, refreshing: r2, refresh: re2 } = useFetch<JobApplication[]>("recruitment.applications.list", {});

  const jobList = jobs ?? [];
  const appList = apps ?? [];
  const openCount = jobList.filter((j) => j.status === "OPEN").length;
  const totalApplications = jobList.reduce((s, j) => s + (j.applicationCount ?? 0), 0);
  const interviewing = appList.filter((a) => a.status === "INTERVIEW").length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={r1 || r2} tintColor={Colors.info} onRefresh={() => { re1(); re2(); }} />}
    >
      <LinearGradient colors={["#06B6D4", "#0EA5E9"]} style={styles.header}>
        <Text style={styles.title}>Recruitment</Text>
        <Text style={styles.sub}>Talent acquisition pipeline</Text>
        <View style={styles.statsRow}>
          <StatChip value={openCount}            label="Open roles"   color="#fff" style={styles.sc} />
          <StatChip value={totalApplications}    label="Applications" color="#fff" style={styles.sc} />
          <StatChip value={interviewing}         label="Interviews"   color="#fff" style={styles.sc} />
        </View>
      </LinearGradient>

      <View style={styles.body}>
        {/* Openings */}
        <SectionHeader title="Positions" style={{ marginBottom: Spacing.md }} />
        {jobList.length === 0
          ? <Card><EmptyState icon="💼" title="No positions yet" subtitle="Openings created in the web app appear here" /></Card>
          : jobList.map(job => (
            <Card key={job.id} style={styles.jobCard}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                <View style={{ flex: 1 }}>
                  <Text style={Typography.h3} numberOfLines={1}>{job.title}</Text>
                  <Text style={[Typography.bodyS, { marginTop: 3 }]}>
                    {[job.departmentName, job.branchName].filter(Boolean).join(" · ") || "—"}
                  </Text>
                  <View style={styles.jobTags}>
                    <View style={styles.jobTag}><Text style={styles.jobTagText}>{job.employmentType.replace("_", " ")}</Text></View>
                    <View style={styles.jobTag}><Text style={styles.jobTagText}>{job.openings} opening{job.openings !== 1 ? "s" : ""}</Text></View>
                    <View style={styles.jobTag}><Text style={styles.jobTagText}>{job.applicationCount} applied</Text></View>
                    {job.deadline && (
                      <View style={[styles.jobTag, { backgroundColor: Colors.dangerLight }]}>
                        <Text style={[styles.jobTagText, { color: Colors.danger }]}>
                          Closes {new Date(job.deadline).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
                <Badge label={job.status} />
              </View>
            </Card>
          ))
        }

        {/* Applications pipeline */}
        <SectionHeader title="Applications" style={styles.sectionGap} />
        {appList.length === 0
          ? <Card><EmptyState icon="📋" title="No applications" subtitle="Candidate applications from the careers site appear here" /></Card>
          : appList.slice(0, 30).map(app => (
            <Card key={app.id} style={[styles.jobCard, { flexDirection: "row", alignItems: "center" }]}>
              <View style={styles.appIcon}>
                <Ionicons name="briefcase" size={18} color={Colors.info} />
              </View>
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
                <Text style={Typography.h4} numberOfLines={1}>{app.candidateName ?? app.openingTitle ?? "Application"}</Text>
                <Text style={Typography.bodyS}>
                  {app.openingTitle} · {new Date(app.createdAt).toLocaleDateString()}
                </Text>
              </View>
              <Badge label={app.status} />
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
  statsRow: { flexDirection: "row", gap: Spacing.sm },
  sc: { backgroundColor: "rgba(255,255,255,0.18)", borderRadius: Radius.lg },
  body: { padding: Spacing.lg },
  sectionGap: { marginTop: Spacing.xl, marginBottom: Spacing.md },
  jobCard: { marginBottom: Spacing.sm },
  jobTags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: Spacing.sm },
  jobTag: {
    backgroundColor: Colors.primaryLight, borderRadius: Radius.full,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  jobTagText: { fontSize: 11, fontWeight: "600", color: Colors.primary },
  appIcon: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: Colors.infoLight, justifyContent: "center", alignItems: "center",
  },
});

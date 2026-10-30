<<<<<<< HEAD
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
=======
// Recruitment screen — open jobs, my applications, referrals

import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
>>>>>>> origin/main
  Platform, StatusBar, RefreshControl,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFetch } from "@/src/hooks/useFetch";
import { Card, Badge, EmptyState, SectionHeader, StatChip } from "@/src/components/ui";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

<<<<<<< HEAD
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
=======
interface Job {
  id: string; title: string; department: string; type: string;
  location: string; openings: number; closingDate?: string;
}
interface Application {
  id: string; jobTitle: string; stage: string; appliedAt: string;
}

export default function RecruitmentScreen() {
  const { data: jobsData,  refreshing: r1, refresh: re1 } = useFetch<{ data: Job[] }>("recruitment.openJobs", { page: 1 });
  const { data: appsData,  refreshing: r2, refresh: re2 } = useFetch<{ data: Application[] }>("recruitment.myApplications", {});
  const { data: statsData, refresh: re3 } = useFetch<{ total: number; active: number; hired: number; interviews: number }>("recruitment.stats", {});

  const jobs  = jobsData?.data  ?? [];
  const apps  = appsData?.data  ?? [];
  const stats = statsData;
>>>>>>> origin/main

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
<<<<<<< HEAD
      refreshControl={<RefreshControl refreshing={r1 || r2} tintColor={Colors.info} onRefresh={() => { re1(); re2(); }} />}
=======
      refreshControl={<RefreshControl refreshing={r1 || r2} tintColor={Colors.info} onRefresh={() => { re1(); re2(); re3(); }} />}
>>>>>>> origin/main
    >
      <LinearGradient colors={["#06B6D4", "#0EA5E9"]} style={styles.header}>
        <Text style={styles.title}>Recruitment</Text>
        <Text style={styles.sub}>Talent acquisition pipeline</Text>
<<<<<<< HEAD
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
=======
        {stats && (
          <View style={styles.statsRow}>
            <StatChip value={stats.total}      label="Total"      color="#fff" style={styles.sc} />
            <StatChip value={stats.active}     label="Active"     color="#fff" style={styles.sc} />
            <StatChip value={stats.interviews} label="Interviews" color="#fff" style={styles.sc} />
            <StatChip value={stats.hired}      label="Hired"      color="#fff" style={styles.sc} />
          </View>
        )}
      </LinearGradient>

      <View style={styles.body}>
        {/* Open Jobs */}
        <SectionHeader title="Open Positions" style={{ marginBottom: Spacing.md }} />
        {jobs.length === 0
          ? <Card><EmptyState icon="💼" title="No open positions" /></Card>
          : jobs.map(job => (
>>>>>>> origin/main
            <Card key={job.id} style={styles.jobCard}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                <View style={{ flex: 1 }}>
                  <Text style={Typography.h3} numberOfLines={1}>{job.title}</Text>
<<<<<<< HEAD
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
=======
                  <Text style={[Typography.bodyS, { marginTop: 3 }]}>{job.department} · {job.location}</Text>
                  <View style={styles.jobTags}>
                    <View style={styles.jobTag}><Text style={styles.jobTagText}>{job.type}</Text></View>
                    <View style={styles.jobTag}><Text style={styles.jobTagText}>{job.openings} opening{job.openings !== 1 ? "s" : ""}</Text></View>
                    {job.closingDate && (
                      <View style={[styles.jobTag, { backgroundColor: Colors.dangerLight }]}>
                        <Text style={[styles.jobTagText, { color: Colors.danger }]}>
                          Closes {new Date(job.closingDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
>>>>>>> origin/main
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
<<<<<<< HEAD
                <Badge label={job.status} />
=======
                <TouchableOpacity style={styles.applyBtn}>
                  <Ionicons name="send" size={14} color="#fff" />
                  <Text style={styles.applyBtnText}>Refer</Text>
                </TouchableOpacity>
>>>>>>> origin/main
              </View>
            </Card>
          ))
        }

<<<<<<< HEAD
        {/* Applications pipeline */}
        <SectionHeader title="Applications" style={styles.sectionGap} />
        {appList.length === 0
          ? <Card><EmptyState icon="📋" title="No applications" subtitle="Candidate applications from the careers site appear here" /></Card>
          : appList.slice(0, 30).map(app => (
=======
        {/* My Applications */}
        <SectionHeader title="My Applications" style={styles.sectionGap} />
        {apps.length === 0
          ? <Card><EmptyState icon="📋" title="No applications" subtitle="Refer someone or apply for an open role" /></Card>
          : apps.map(app => (
>>>>>>> origin/main
            <Card key={app.id} style={[styles.jobCard, { flexDirection: "row", alignItems: "center" }]}>
              <View style={styles.appIcon}>
                <Ionicons name="briefcase" size={18} color={Colors.info} />
              </View>
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
<<<<<<< HEAD
                <Text style={Typography.h4} numberOfLines={1}>{app.candidateName ?? app.openingTitle ?? "Application"}</Text>
                <Text style={Typography.bodyS}>
                  {app.openingTitle} · {new Date(app.createdAt).toLocaleDateString()}
                </Text>
              </View>
              <Badge label={app.status} />
            </Card>
          ))}
=======
                <Text style={Typography.h4} numberOfLines={1}>{app.jobTitle}</Text>
                <Text style={Typography.bodyS}>{new Date(app.appliedAt).toLocaleDateString()}</Text>
              </View>
              <Badge label={app.stage} />
            </Card>
          ))
        }
>>>>>>> origin/main
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
<<<<<<< HEAD
  jobTags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: Spacing.sm },
=======
  jobTags: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs, marginTop: Spacing.sm },
>>>>>>> origin/main
  jobTag: {
    backgroundColor: Colors.primaryLight, borderRadius: Radius.full,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  jobTagText: { fontSize: 11, fontWeight: "600", color: Colors.primary },
<<<<<<< HEAD
=======
  applyBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: Colors.info, borderRadius: Radius.md,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  applyBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
>>>>>>> origin/main
  appIcon: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: Colors.infoLight, justifyContent: "center", alignItems: "center",
  },
});

// Attendance screen — GPS check-in/out (offline outbox), selfie check-in,
// today card, weekly summary
//
// SERVER CONTRACTS (verified 2026-10-30, extended M3):
//   ess.attendance            (routes/ess.ts:60)  → { records, summary, today }   (self-scoped)
//   tracking.status           (routes/tracking.ts:239) → { trackingEnabled, attendanceMethods, mandatoryGps, … }
//   attendance.geofence.checkin  (routes/attendance.ts, S.geoCheckin)  — lat/lng REQUIRED, clientEventId idempotent ("ci:"), offlineCapture flag
//   attendance.geofence.checkout (routes/attendance.ts, S.geoCheckout) — lat/lng REQUIRED, clientEventId idempotent ("co:"), offlineCapture flag
//   attendance.selfCheckout     (routes/attendance.ts:707, S.selfCheckout)  — online-only fallback when GPS unavailable
//   attendance.selfie.checkin   (routes/attendance.ts, S.selfieCheckin) — selfieDataUrl REQUIRED (≤2.5MB data-URL),
//                              clientEventId idempotent ("si:"), GPS best-effort
//
// M3 OFFLINE MODEL (docs/engineering/OFFLINE_OUTBOX.md):
//   geofence punches are recorded on-device via the outbox and replayed with
//   the same clientEventId — a punch is ONLY shown as successful after the
//   server confirms it (status "synced"). While pending, the today card
//   shows "recorded on your phone — waiting to sync". Selfie punches are
//   ONLINE-ONLY (photos are sensitive personal data, deliberately never
//   queued on-device); their upload retry reuses the same clientEventId so a
//   dropped response can never double-punch.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  View, Text, ScrollView, RefreshControl, StyleSheet,
  Platform, StatusBar, Alert, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { rpc, ApiError } from "@/src/lib/api";
import { getLocationWithAccuracy } from "@/src/lib/location";
import { submitPunch, retryEntry, dismissEntry, removePendingEntry, useOutboxStore, type OutboxEntry } from "@/src/lib/offline";
import { Card, Button, Badge, SectionHeader, EmptyState } from "@/src/components/ui";
import { SelfieCapture, type SelfieShot } from "@/src/components/SelfieCapture";
import { Colors, Spacing, Typography, Radius } from "@/src/theme";

interface AttRecord {
  id?: string;
  date?: string;
  checkIn?: string | null;
  checkOut?: string | null;
  status?: string;
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

interface TrackingStatus {
  trackingEnabled?: boolean;
  attendanceMethods?: { methods?: string[]; selfieRequired?: boolean; requireGeofence?: boolean } | null;
  mandatoryGps?: { active?: boolean } | null;
}

function fmt(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function mins2h(m?: number) {
  if (!m) return "0h 0m";
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Monday of the current week, as YYYY-MM-DD. */
function weekStart(): string {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

/** RFC4122-ish v4 id — used for the selfie upload's clientEventId (one per
 *  confirmed capture; a retry of a failed upload reuses it so the server
 *  replay contract answers instead of a second punch). */
function newClientEventId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Outbox queue display
// ---------------------------------------------------------------------------

type QueueChip = {
  key: string;
  label: string;
  color: string;
  icon: keyof typeof Ionicons.glyphMap;
  spin?: boolean;
};

function entryChip(e: OutboxEntry): QueueChip {
  if (e.status === "syncing") return { key: e.id, label: "Synchronizing…", color: Colors.primary, icon: "sync", spin: true };
  if (e.status === "synced") {
    return e.requiresReview
      ? { key: e.id, label: "Accepted — under review", color: Colors.warning, icon: "eye-outline" }
      : { key: e.id, label: "Synchronized", color: Colors.success, icon: "checkmark-circle" };
  }
  if (e.status === "rejected") return { key: e.id, label: "Not sent — server rejected", color: Colors.danger, icon: "close-circle" };
  // pending
  if (e.lastError) return { key: e.id, label: "Failed — will retry", color: Colors.warning, icon: "refresh-circle" };
  return { key: e.id, label: "Pending sync", color: Colors.warning, icon: "time-outline" };
}

function entryTitle(e: OutboxEntry): string {
  const time = new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${e.action === "attendance.geofence.checkin" ? "Check-in" : "Check-out"} · ${time}${e.capturedOffline ? " · recorded offline" : ""}`;
}

function QueueCard({ entry }: { entry: OutboxEntry }) {
  const chip = entryChip(entry);
  return (
    <Card style={{ flexDirection: "row", alignItems: "center", gap: Spacing.md, padding: Spacing.md }}>
      <View style={[styles.qIcon, { backgroundColor: chip.color + "18" }]}>
        {chip.spin ? (
          <ActivityIndicator color={chip.color} size="small" />
        ) : (
          <Ionicons name={chip.icon} size={20} color={chip.color} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={Typography.h4}>{entryTitle(entry)}</Text>
        <Text style={[Typography.bodyS, { color: chip.color, fontWeight: "600", marginTop: 2 }]}>{chip.label}</Text>
        {e_retryable(entry) && (
          <TouchableOpacity onPress={() => retryEntry(entry.id)} hitSlop={{ top: 8, bottom: 8 }}>
            <Text style={styles.qRetry}>Retry now</Text>
          </TouchableOpacity>
        )}
        {entry.status === "rejected" && (
          <TouchableOpacity onPress={() => dismissEntry(entry.id)} hitSlop={{ top: 8, bottom: 8 }}>
            <Text style={styles.qDismiss}>Dismiss</Text>
          </TouchableOpacity>
        )}
        {entry.lastError ? <Text style={styles.qError}>{entry.lastError}</Text> : null}
      </View>
    </Card>
  );
}

function e_retryable(entry: OutboxEntry): boolean {
  return entry.status === "pending" && entry.lastError != null;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function AttendanceScreen() {
  const [today, setToday]       = useState<AttRecord | null>(null);
  const [week, setWeek]         = useState<WeekRow[]>([]);
  const [methods, setMethods]   = useState<string[]>([]);
  const [selfieRequired, setSelfieRequired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [locating, setLocating] = useState(false);

  // outbox reactive state (queue + connectivity)
  const queue = useOutboxStore((s) => s.entries);
  const online = useOutboxStore((s) => s.online);
  const syncing = useOutboxStore((s) => s.syncing);

  // selfie capture sheet
  const [selfieMode, setSelfieMode] = useState<null | { kind: "selfie-checkin" } | { kind: "attach-geo" }>(null);
  // GPS fix captured for a punch that still needs its policy-required selfie
  const [pendingGeoLoc, setPendingGeoLoc] = useState<{ latitude: number; longitude: number; accuracy?: number } | null>(null);

  // pending selfie upload retry state (same clientEventId → server replay)
  const [selfieUpload, setSelfieUpload] = useState<null | {
    clientEventId: string;
    payload: Record<string, unknown>;
    busy: boolean;
  }>(null);

  const selfieAllowed = useMemo(
    () => methods.some((m) => m === "SELFIE" || m === "GEOFENCE_SELFIE"),
    [methods],
  );

  const load = useCallback(async (_silent = false) => {
    try {
      const [att, status] = await Promise.allSettled([
        rpc<{ records: AttRecord[]; summary: Record<string, number>; today: AttRecord | null }>("ess.attendance", {}),
        rpc<TrackingStatus>("tracking.status", {}),
      ]);
      if (att.status === "fulfilled") {
        setToday(att.value?.today ?? null);
        const ws = weekStart();
        setWeek(
          (att.value?.records ?? [])
            .filter((r) => (r.date ?? "") >= ws)
            .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
            .map((r) => ({
              date: r.date ?? "",
              status: r.status ?? "—",
              checkIn: r.checkIn,
              checkOut: r.checkOut,
              workingMinutes: r.workingMinutes,
            })),
        );
      }
      if (status.status === "fulfilled") {
        setMethods(status.value?.attendanceMethods?.methods ?? []);
        setSelfieRequired(Boolean(status.value?.attendanceMethods?.selfieRequired));
      }
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, []);

  // ---- geofence punch via the offline outbox -----------------------------

  const submitGeoPunch = useCallback(async (
    action: "attendance.geofence.checkin" | "attendance.geofence.checkout",
    loc: { latitude: number; longitude: number; accuracy?: number },
    selfie?: SelfieShot,
  ) => {
    setActionLoading(true);
    try {
      const entry = await submitPunch(action, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracyM: loc.accuracy ?? null,
        ...(selfie ? { selfieDataUrl: selfie.dataUrl, selfieQuality: selfie.quality } : {}),
        deviceInfo: `${Platform.OS === "ios" ? "iOS" : "Android"} · Finix HR mobile`,
        gpsStatus: (loc.accuracy ?? 999) > 100 ? "LOW_ACCURACY" : "OK",
        networkStatus: "ONLINE",
      }, { capturedOffline: online === false });

      if (!entry) return;
      if (entry.status === "synced") {
        if (entry.requiresReview) {
          Alert.alert(
            "Punch Recorded — Pending Review",
            "Your punch was accepted and flagged for HR review (recorded offline or location verification). HR can confirm or adjust it.",
          );
        }
        await load(true);
      } else if (entry.status === "pending" && selfie) {
        // PHOTO-SAFETY: this punch carries the policy-required selfie, and
        // its first submission did not land. The entry (with photo bytes)
        // must NOT sit in device storage — remove it and tell the user the
        // punch was not recorded. Offline photo storage is out of scope by
        // design (privacy), so a selfie punch honestly requires connectivity.
        await removePendingEntry(entry.id);
        Alert.alert(
          "Connection Needed",
          "Your policy requires a selfie with this punch, and the photo could not be uploaded. The punch was NOT recorded — reconnect and try again. (Your photo is never stored on the phone.)",
        );
      } else if (entry.status === "pending") {
        Alert.alert(
          "Saved on Your Phone",
          online === false
            ? "You are offline. Your punch was recorded and will sync automatically when connectivity returns — it is not official until then."
            : entry.lastError ?? "Your punch could not be confirmed yet — it will retry automatically.",
        );
      } else if (entry.status === "rejected") {
        Alert.alert("Punch Not Accepted", entry.lastError ?? "The server rejected this punch.");
      }
    } catch (e) {
      // local guard violations (duplicate pending punch, queue full) or
      // unexpected errors — show honestly
      Alert.alert("Check-in Problem", e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setActionLoading(false);
    }
  }, [load, online]);

  const handleCheckin = useCallback(async () => {
    if (selfieRequired && online === false) {
      Alert.alert(
        "Connection Needed",
        "Your attendance policy requires a selfie with every check-in. Selfie punches need a connection — the photo is uploaded immediately and is never stored on your phone. Reconnect and try again.",
      );
      return;
    }
    setLocating(true);
    const loc = await getLocationWithAccuracy().finally(() => setLocating(false));
    if (!loc) { Alert.alert("Location Required", "Enable location access to check in — geo-fence attendance needs your GPS position."); return; }
    if (selfieRequired) {
      // policy requires a selfie with the geo punch — capture BEFORE submitting
      setSelfieMode({ kind: "attach-geo" });
      setPendingGeoLoc(loc);
      return;
    }
    await submitGeoPunch("attendance.geofence.checkin", loc);
  }, [selfieRequired, online, submitGeoPunch]);

  const handleCheckout = useCallback(async () => {
    if (selfieRequired && online === false) {
      Alert.alert("Connection Needed", "Your policy requires a selfie for check-out — reconnect and try again.");
      return;
    }
    setLocating(true);
    const loc = await getLocationWithAccuracy().finally(() => setLocating(false));
    try {
      if (loc) {
        if (selfieRequired) {
          setSelfieMode({ kind: "attach-geo" });
          setPendingGeoLoc(loc);
          return;
        }
        await submitGeoPunch("attendance.geofence.checkout", loc);
      } else {
        // Fallback: plain self check-out (S.selfCheckout — nullish coords OK).
        // No clientEventId in the schema → online-only, honest about it.
        if (online === false) {
          Alert.alert("Connection Needed", "Check-out without GPS needs a connection. Move to an open area for a GPS fix, or reconnect.");
          return;
        }
        setActionLoading(true);
        try {
          await rpc("attendance.selfCheckout", {});
          await load(true);
        } catch (e) {
          Alert.alert("Check-out Failed", e instanceof ApiError ? e.message : "Check-out failed. Please try again.");
        } finally { setActionLoading(false); }
      }
    } finally { setLocating(false); }
  }, [selfieRequired, online, submitGeoPunch, load]);

  // ---- selfie check-in (dedicated button; online-only) --------------------

  const handleSelfieCheckin = useCallback(() => {
    if (online === false) {
      Alert.alert(
        "Connection Needed",
        "Selfie check-in needs a connection — your photo is uploaded immediately as proof of presence and is never stored on your phone.",
      );
      return;
    }
    setSelfieMode({ kind: "selfie-checkin" });
  }, [online]);

  const submitSelfieCheckin = useCallback(async (shot: SelfieShot) => {
    setSelfieMode(null);
    setActionLoading(true);
    // GPS is best-effort for a selfie punch (S.selfieCheckin lat/lng
    // nullish) — real or absent, never fabricated
    const loc = await getLocationWithAccuracy().catch(() => null);
    const clientEventId = newClientEventId();
    const payload: Record<string, unknown> = {
      selfieDataUrl: shot.dataUrl,
      selfieQuality: shot.quality,
      ...(loc ? { latitude: loc.latitude, longitude: loc.longitude, accuracyM: loc.accuracy ?? null } : {}),
      deviceInfo: `${Platform.OS === "ios" ? "iOS" : "Android"} · Finix HR mobile`,
      gpsStatus: loc ? ((loc.accuracy ?? 999) > 100 ? "LOW_ACCURACY" : "OK") : "UNAVAILABLE",
      networkStatus: "ONLINE",
      clientEventId,
      clientTimestamp: new Date().toISOString(),
    };
    try {
      const res = await rpc<{ requiresReview?: boolean; eventStatus?: string }>("attendance.selfie.checkin", payload);
      setSelfieUpload(null);
      if (res?.eventStatus === "REVIEW_REQUIRED" || res?.eventStatus === "SUSPICIOUS") {
        Alert.alert("Punch Recorded — Pending Review", "Your selfie check-in was accepted and flagged for HR review.");
      }
      await load(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSelfieUpload(null);
        Alert.alert("Session Expired", "Please log in again, then take the selfie check-in once more.");
      } else if (e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429)) {
        // upload failure — keep the confirmed shot IN MEMORY with its
        // clientEventId; retrying replays the same id (no double punch)
        setSelfieUpload({ clientEventId, payload, busy: false });
        Alert.alert("Upload Failed", "The photo could not be uploaded. Use Retry below — it is safe to retry.");
      } else {
        setSelfieUpload(null);
        Alert.alert("Selfie Check-in Failed", e instanceof ApiError ? e.message : "The check-in was not accepted.");
      }
    } finally {
      setActionLoading(false);
    }
  }, [load]);

  const retrySelfieUpload = useCallback(async () => {
    if (!selfieUpload || selfieUpload.busy) return;
    setSelfieUpload({ ...selfieUpload, busy: true });
    try {
      await rpc("attendance.selfie.checkin", selfieUpload.payload);
      setSelfieUpload(null);
      await load(true);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401) {
        // permanent server decision — stop retrying, show it
        setSelfieUpload(null);
        Alert.alert("Selfie Check-in Failed", e.message);
      } else {
        Alert.alert("Upload Failed", "Still no connection. The photo stays ready — try again later.");
        setSelfieUpload((u) => (u ? { ...u, busy: false } : null));
      }
    }
  }, [selfieUpload, load]);

  // ---- derived display state ----------------------------------------------

  const pendingCheckin = queue.find((e) => e.action === "attendance.geofence.checkin" && (e.status === "pending" || e.status === "syncing"));
  const pendingCheckout = queue.find((e) => e.action === "attendance.geofence.checkout" && (e.status === "pending" || e.status === "syncing"));
  // "now" for the synced-entries display cutoff — captured as state and
  // refreshed whenever the queue changes (never read Date.now() during
  // render: the react-compiler lint rightly flags impure render calls)
  const [queueNow, setQueueNow] = useState(() => Date.now());
  useEffect(() => { setQueueNow(Date.now()); }, [queue]);
  const visibleQueue = useMemo(
    () => queue.filter((e) => e.status !== "synced" || queueNow - Date.parse(e.syncedAt ?? e.createdAt) < 24 * 3600_000),
    [queue, queueNow],
  );

  // SERVER data drives the buttons; a punch awaiting sync disables a repeat
  // punch of the same kind (the outbox also refuses it locally)
  const alreadyIn  = Boolean(today?.checkIn) || Boolean(pendingCheckin);
  const alreadyOut = Boolean(today?.checkOut) || Boolean(pendingCheckout);

  const isOnline = online !== false;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={Colors.primary} onRefresh={() => { setRefreshing(true); load(true); }} />}
    >
      {/* Header */}
      <LinearGradient colors={["#4F46E5", "#06B6D4"]} style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Attendance</Text>
          {/* Connectivity indicator — drives every offline affordance below */}
          <View style={[styles.netChip, { backgroundColor: isOnline ? "rgba(16,185,129,0.25)" : "rgba(245,158,11,0.3)" }]}>
            <Ionicons name={isOnline ? "cloud-done-outline" : "cloud-offline-outline"} size={13} color="#fff" />
            <Text style={styles.netChipText}>{isOnline ? (syncing ? "Syncing" : "Online") : "Offline"}</Text>
          </View>
        </View>
        <Text style={styles.headerSub}>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</Text>

        {/* Today card — SERVER data only; a pending punch is labeled as pending */}
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
              {pendingCheckin && !today?.checkIn && <Text style={styles.tpending}>pending sync</Text>}
            </View>
            <View style={styles.vDivider} />
            <View style={{ alignItems: "center" }}>
              <Ionicons name="log-out-outline" size={20} color="rgba(255,255,255,0.8)" />
              <Text style={styles.tlabel}>Check-out</Text>
              <Text style={styles.tval}>{fmt(today?.checkOut)}</Text>
              {pendingCheckout && !today?.checkOut && <Text style={styles.tpending}>pending sync</Text>}
            </View>
            <View style={styles.vDivider} />
            <View style={{ alignItems: "center" }}>
              <Ionicons name="timer-outline" size={20} color="rgba(255,255,255,0.8)" />
              <Text style={styles.tlabel}>Hours</Text>
              <Text style={styles.tval}>{mins2h(today?.workingMinutes)}</Text>
            </View>
          </View>
          {methods.length > 0 && (
            <Text style={styles.methodHint}>
              Method policy: {methods.map((m) => (m === "GEOFENCE_SELFIE" ? "Geofence + Selfie" : m === "GEOFENCE" ? "Geofence" : m === "SELFIE" ? "Selfie" : "Device punch")).join(" · ")}
            </Text>
          )}
        </View>
      </LinearGradient>

      <View style={styles.body}>
        {/* Offline explainer — only while disconnected with unsent punches */}
        {!isOnline && visibleQueue.some((e) => e.status === "pending") && (
          <View style={styles.offlineNote}>
            <Ionicons name="cloud-offline-outline" size={18} color={Colors.warning} />
            <Text style={styles.offlineNoteText}>
              You are offline. Punches recorded now are saved on this phone and sync automatically when connectivity returns — they are not official attendance until the server confirms them.
            </Text>
          </View>
        )}

        {/* Pending selfie upload retry (photo held in memory, same clientEventId) */}
        {selfieUpload && (
          <Card style={{ gap: Spacing.sm }}>
            <Text style={Typography.h4}>Selfie ready — upload pending</Text>
            <Text style={Typography.bodyS}>The photo could not be uploaded. Retrying is safe — it never punches twice.</Text>
            <View style={{ flexDirection: "row", gap: Spacing.md }}>
              <Button label={selfieUpload.busy ? "Uploading…" : "Retry Upload"} onPress={retrySelfieUpload} loading={selfieUpload.busy} variant="primary" size="sm" />
              <Button label="Discard" onPress={() => setSelfieUpload(null)} variant="secondary" size="sm" />
            </View>
          </Card>
        )}

        {/* Action buttons */}
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

        {/* Selfie check-in — policy-driven affordance (tracking.status methods) */}
        {!alreadyIn && selfieAllowed && (
          <Button
            label="🤳  Selfie Check-In"
            onPress={handleSelfieCheckin}
            variant="secondary"
            size="lg"
            fullWidth
          />
        )}
        {!alreadyIn && !alreadyOut && selfieRequired && !selfieAllowed && (
          <Text style={styles.selfieNote}>
            Your policy requires a selfie for check-in, but selfie attendance is not in your allowed methods. Contact your HR administrator.
          </Text>
        )}

        {/* Offline punch queue */}
        {visibleQueue.length > 0 && (
          <View style={{ marginTop: Spacing.xl, gap: Spacing.md }}>
            <SectionHeader title="Sync Queue" />
            {visibleQueue.map((e) => <QueueCard key={e.id} entry={e} />)}
          </View>
        )}

        {/* Weekly summary */}
        <View style={{ marginTop: Spacing.xl, gap: Spacing.md }}>
          <SectionHeader title="This Week" />
          {week.length === 0 ? (
            <Card><EmptyState icon="📅" title="No records this week" subtitle="Check in to start tracking your attendance" /></Card>
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

      {/* Selfie capture sheet — one flow serves both the dedicated selfie
          check-in and the policy-required selfie attached to a geo punch */}
      <SelfieCapture
        visible={selfieMode !== null}
        title={selfieMode?.kind === "attach-geo" ? "Selfie required" : "Selfie check-in"}
        hint={
          selfieMode?.kind === "attach-geo"
            ? "Your attendance policy requires a selfie with this punch — your photo is the proof of presence."
            : "Your selfie is the proof of presence for this punch. GPS is attached when available."
        }
        onCancel={() => {
          setSelfieMode(null);
          setPendingGeoLoc(null);
        }}
        onConfirmed={(shot) => {
          if (selfieMode?.kind === "selfie-checkin") {
            submitSelfieCheckin(shot);
          } else if (selfieMode?.kind === "attach-geo" && pendingGeoLoc) {
            const loc = pendingGeoLoc;
            setSelfieMode(null);
            setPendingGeoLoc(null);
            // which action was pending? check-out if already checked in
            const action = today?.checkIn ? "attendance.geofence.checkout" : "attendance.geofence.checkin";
            submitGeoPunch(action, loc, shot);
          } else {
            setSelfieMode(null);
            setPendingGeoLoc(null);
          }
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: Platform.OS === "ios" ? 60 : (StatusBar.currentHeight ?? 0) + 16,
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xxl,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerTitle: { color: "#fff", fontSize: 24, fontWeight: "800" },
  headerSub:   { color: "rgba(255,255,255,0.7)", fontSize: 13, marginTop: 2, marginBottom: Spacing.lg },
  netChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.full,
  },
  netChipText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  todayCard: {
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  methodHint: { color: "rgba(255,255,255,0.65)", fontSize: 10, marginTop: Spacing.md, textAlign: "center" },
  tlabel: { color: "rgba(255,255,255,0.65)", fontSize: 11, marginTop: 4 },
  tval:   { color: "#fff", fontWeight: "700", fontSize: 17, marginTop: 2 },
  tpending: { color: "#FDE68A", fontSize: 9, fontWeight: "700", marginTop: 2 },
  vDivider: { width: 1, backgroundColor: "rgba(255,255,255,0.2)", marginVertical: 4 },
  body: { padding: Spacing.lg, gap: 0 },
  doneRow: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    backgroundColor: Colors.successLight, borderRadius: Radius.lg,
    padding: Spacing.lg, justifyContent: "center",
  },
  dayCircle: { width: 44, height: 44, borderRadius: 12, justifyContent: "center", alignItems: "center" },
  offlineNote: {
    flexDirection: "row", gap: Spacing.sm, alignItems: "flex-start",
    backgroundColor: Colors.warningLight, borderRadius: Radius.md,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  offlineNoteText: { flex: 1, color: "#92400E", fontSize: 12, lineHeight: 18, fontWeight: "500" },
  selfieNote: { color: Colors.textSecondary, fontSize: 12, lineHeight: 18, marginTop: Spacing.sm, textAlign: "center" },
  qIcon: { width: 40, height: 40, borderRadius: 12, justifyContent: "center", alignItems: "center" },
  qRetry: { color: Colors.primary, fontWeight: "700", fontSize: 12, marginTop: 6 },
  qDismiss: { color: Colors.textSecondary, fontWeight: "600", fontSize: 12, marginTop: 4 },
  qError: { color: Colors.danger, fontSize: 11, marginTop: 4, lineHeight: 15 },
});

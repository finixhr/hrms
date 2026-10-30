// First-login MFA enrollment wizard (T-14).
//
// Reached from login when the server answers auth.login with
// { mfaEnrollmentRequired: true, enrollToken } — an unenrolled user on an
// MFA-required role (VENDOR_OWNER / HR_ADMIN by default). The enrollToken is
// a 15-minute PREAUTH capability that proves the password already verified;
// it carries NO API rights, so there is nothing to protect in this screen
// beyond the token itself.
//
// Flow (server contract — src/hrm-server/routes/auth.ts):
//   auth.mfa.enroll.start  { enrollToken }           → { secret, qrDataUrl, uri }
//   auth.mfa.enroll.enable { enrollToken, code }     → { token, user, recoveryCodes }
//
// Honesty rules this screen follows:
//   · no "enabled" claim before auth.mfa.enroll.enable actually succeeds;
//   · the recovery codes are shown EXACTLY once (the server never returns
//     them again) and the user must explicitly confirm saving them;
//   · an expired enrollment window (401) routes back to sign-in — the
//     password must be re-proven, never silently retried.
//
// This is standard TOTP enrollment — no biometric or liveness claims.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  ScrollView, Image, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuthStore, type MfaEnrollStartResult } from "@/src/lib/auth";
import { Input, Button } from "@/src/components/ui";
import { Colors, Spacing, Typography, Shadow, Radius } from "@/src/theme";

type Step = "qr" | "verify" | "recovery";

// Render a base32 TOTP secret in readable 4-character groups.
function groupSecret(secret: string): string {
  return (secret || "").replace(/\s/g, "").replace(/(.{4})/g, "$1 ").trim();
}

export default function MfaEnrollScreen() {
  const router = useRouter();
  const {
    enrollToken, isLoading, error, clearError,
    startMfaEnrollment, completeMfaEnrollment, logout,
  } = useAuthStore();

  const [step, setStep] = useState<Step>("qr");
  const [enrollData, setEnrollData] = useState<MfaEnrollStartResult | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const fetchedFor = useRef<string | null>(null);

  const backToLogin = useCallback(async () => {
    // Clear the (now useless) enrollment state; the user re-proves the password.
    await logout().catch(() => null);
    router.replace("/(auth)/login");
  }, [logout, router]);

  // Guard: this screen is only valid with a pending enrollment session.
  useEffect(() => {
    if (!enrollToken && !enrollData && !isLoading) {
      router.replace("/(auth)/login");
    }
  }, [enrollToken, enrollData, isLoading, router]);

  // Fetch the QR + secret once per enrollToken (the server issues a FRESH
  // secret on every start call — a re-fetch would silently invalidate the
  // code the user is already typing into their authenticator).
  useEffect(() => {
    if (!enrollToken || fetchedFor.current === enrollToken) return;
    fetchedFor.current = enrollToken;
    let cancelled = false;
    (async () => {
      try {
        const data = await startMfaEnrollment();
        if (!cancelled) { setEnrollData(data); setStartFailed(false); }
      } catch {
        if (!cancelled) setStartFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [enrollToken]);

  async function handleVerify() {
    clearError(); setLocalError(null);
    if (code.trim().length < 6) {
      setLocalError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    try {
      const codes = await completeMfaEnrollment(code.trim());
      setRecoveryCodes(codes);
      setStep("recovery");
    } catch {
      // surfaced via the store's error state (server messages are
      // user-appropriate: wrong code / expired window / rate limit)
    }
  }

  async function handleDone() {
    // The session is already live; leave the auth group.
    router.replace("/(tabs)");
  }

  const shownError = localError ?? error;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {/* Hero gradient — matches the login screen */}
        <LinearGradient colors={["#4F46E5", "#7C3AED"]} style={styles.hero}>
          <View style={styles.logoWrap}>
            <View style={styles.logoCircle}>
              <Ionicons name="shield-checkmark" size={32} color="#fff" />
            </View>
            <Text style={styles.logoText}>Secure your account</Text>
            <Text style={styles.logoSub}>One-time multi-factor setup</Text>
          </View>
        </LinearGradient>

        <View style={styles.card}>
          {/* Step 1 — scan the QR / read the secret */}
          {step === "qr" && (
            <>
              <Text style={Typography.h2}>Set up your authenticator</Text>
              <Text style={[Typography.body, { marginTop: 4, marginBottom: Spacing.lg }]}>
                Your role requires multi-factor authentication. Scan this code with Google
                Authenticator, Microsoft Authenticator, 1Password or any TOTP app.
              </Text>

              <View style={styles.qrCard}>
                {enrollData ? (
                  // jsx-a11y/alt-text wants an `alt` prop (web DOM); React
                  // Native Image has no alt — the RN equivalent,
                  // accessibilityLabel, is set below and is what VoiceOver/
                  // TalkBack actually read.
                  // eslint-disable-next-line jsx-a11y/alt-text
                  <Image
                    source={{ uri: enrollData.qrDataUrl }}
                    style={styles.qrImage}
                    resizeMode="contain"
                    accessible
                    accessibilityLabel="TOTP enrollment QR code"
                    accessibilityRole="image"
                  />
                ) : startFailed ? (
                  <View style={styles.qrFallback}>
                    <Ionicons name="cloud-offline-outline" size={28} color={Colors.textTertiary} />
                    <Text style={[Typography.bodyS, { textAlign: "center", marginTop: Spacing.sm }]}>
                      Could not load the setup code. Check your connection and try again.
                    </Text>
                    <Button
                      label="Retry"
                      variant="secondary"
                      size="sm"
                      onPress={() => { fetchedFor.current = null; setStartFailed(false); startMfaEnrollment().then(setEnrollData).catch(() => setStartFailed(true)); }}
                      style={{ marginTop: Spacing.md }}
                    />
                  </View>
                ) : (
                  <View style={styles.qrFallback}>
                    <ActivityIndicator color={Colors.primary} />
                    <Text style={[Typography.bodyS, { marginTop: Spacing.sm }]}>
                      Generating your secure key…
                    </Text>
                  </View>
                )}
              </View>

              {enrollData && (
                <View style={styles.secretBox}>
                  <Text style={Typography.label}>Can&apos;t scan? Enter this key manually</Text>
                  <Text selectable style={styles.secretText}>
                    {groupSecret(enrollData.secret)}
                  </Text>
                </View>
              )}

              {shownError ? <Text style={styles.error}>{shownError}</Text> : null}

              <Button
                label="I&apos;ve scanned the code"
                onPress={() => { clearError(); setLocalError(null); setStep("verify"); }}
                disabled={!enrollData}
                fullWidth
                style={{ marginTop: Spacing.xl }}
              />
              <TouchableOpacity onPress={backToLogin} style={styles.secondaryBtn}>
                <Text style={styles.secondaryText}>Cancel and sign in later</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Step 2 — verify the first code */}
          {step === "verify" && (
            <>
              <Text style={Typography.h2}>Enter the 6-digit code</Text>
              <Text style={[Typography.body, { marginTop: 4, marginBottom: Spacing.lg }]}>
                Your app now generates a new code every 30 seconds. Enter the current one to
                confirm the setup.
              </Text>
              <Input
                label="Authentication Code"
                value={code}
                onChangeText={(t) => { setCode(t.replace(/[^0-9]/g, "")); setLocalError(null); }}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                placeholder="000000"
                leftIcon={<Ionicons name="key-outline" size={18} color={Colors.textTertiary} />}
              />
              {shownError ? <Text style={styles.error}>{shownError}</Text> : null}
              <Button label="Verify & Enable" onPress={handleVerify} loading={isLoading} fullWidth style={{ marginTop: Spacing.xl }} />
              <TouchableOpacity onPress={() => { clearError(); setLocalError(null); setCode(""); setStep("qr"); }} style={styles.secondaryBtn}>
                <Text style={styles.secondaryText}>Back to the QR code</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Step 3 — recovery codes, shown exactly once */}
          {step === "recovery" && (
            <>
              <View style={styles.successRow}>
                <Ionicons name="checkmark-circle" size={22} color={Colors.success} />
                <Text style={[Typography.h2, { marginLeft: 8 }]}>Multi-factor is enabled</Text>
              </View>
              <Text style={[Typography.body, { marginTop: 4, marginBottom: Spacing.lg }]}>
                Save these recovery codes now — they are the only way to sign in if you lose
                your device.{" "}
                <Text style={{ fontWeight: "700", color: Colors.warning }}>
                  This screen is shown only once.
                </Text>
              </Text>
              <View style={styles.codesBox}>
                {recoveryCodes.length > 0 ? (
                  recoveryCodes.map((c) => (
                    <Text key={c} selectable style={styles.codeText}>
                      {groupSecret(c)}
                    </Text>
                  ))
                ) : (
                  // The server always returns codes on enable; if the array is
                  // somehow empty, say so instead of implying they exist.
                  <Text style={[Typography.bodyS, { color: Colors.danger }]}>
                    No recovery codes were returned by the server — contact your administrator
                    before signing out.
                  </Text>
                )}
              </View>
              <Button label="I've saved my codes" onPress={handleDone} fullWidth style={{ marginTop: Spacing.xl }} />
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  hero: { paddingTop: 64, paddingBottom: 48, alignItems: "center" },
  logoWrap: { alignItems: "center", gap: 10 },
  logoCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: "rgba(255,255,255,0.18)",
    justifyContent: "center", alignItems: "center",
    borderWidth: 1.5, borderColor: "rgba(255,255,255,0.35)",
  },
  logoText: { color: "#fff", fontSize: 24, fontWeight: "800", letterSpacing: -0.5 },
  logoSub:  { color: "rgba(255,255,255,0.75)", fontSize: 13, fontWeight: "500" },
  card: {
    flex: 1, backgroundColor: Colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    marginTop: -28, padding: Spacing.xl, paddingTop: 32,
    ...Shadow.lg,
  },
  qrCard: {
    alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.surfaceAlt, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: Radius.lg, padding: Spacing.lg, minHeight: 252,
  },
  qrImage: { width: 220, height: 220 },
  qrFallback: { alignItems: "center", justifyContent: "center", padding: Spacing.lg },
  secretBox: {
    marginTop: Spacing.md, backgroundColor: Colors.surfaceAlt,
    borderWidth: 1, borderColor: Colors.borderLight, borderRadius: Radius.md,
    padding: Spacing.md, gap: 4,
  },
  secretText: {
    fontFamily: "monospace", fontSize: 15, fontWeight: "600",
    color: Colors.textPrimary, letterSpacing: 1,
  },
  successRow: { flexDirection: "row", alignItems: "center" },
  codesBox: {
    backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.borderLight,
    borderRadius: Radius.md, padding: Spacing.md, gap: 6,
  },
  codeText: {
    fontFamily: "monospace", fontSize: 15, fontWeight: "600",
    color: Colors.textPrimary, letterSpacing: 1,
  },
  secondaryBtn: { alignItems: "center", marginTop: Spacing.lg, paddingVertical: Spacing.sm },
  secondaryText: { color: Colors.textSecondary, fontSize: 13, fontWeight: "600" },
  error: { color: Colors.danger, fontSize: 13, marginTop: Spacing.sm, fontWeight: "500" },
});

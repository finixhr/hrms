// Beautiful login screen with gradient header and polished form

import { useState } from "react";
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  ScrollView, TouchableOpacity, Alert,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "@/src/lib/auth";
import { Input, Button } from "@/src/components/ui";
<<<<<<< HEAD
import { Colors, Spacing, Typography, Shadow } from "@/src/theme";
=======
import { Colors, Spacing, Radius, Typography, Shadow } from "@/src/theme";
>>>>>>> origin/main

export default function LoginScreen() {
  const { login, verifyMfa, mfaPending, isLoading, error, clearError } = useAuthStore();
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [mfaCode, setMfaCode] = useState("");

  async function handleLogin() {
    clearError();
    if (!email.trim() || !password) { Alert.alert("Required", "Please enter email and password."); return; }
    try { await login(email.trim().toLowerCase(), password); } catch { /* shown via error state */ }
  }

  async function handleMfa() {
    clearError();
    if (mfaCode.length < 6) { Alert.alert("Required", "Enter the 6-digit code."); return; }
    try { await verifyMfa(mfaCode.trim()); } catch { /* shown via error state */ }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {/* Hero gradient */}
        <LinearGradient colors={["#4F46E5", "#7C3AED"]} style={styles.hero}>
          <View style={styles.logoWrap}>
            <View style={styles.logoCircle}>
              <Ionicons name="business" size={32} color="#fff" />
            </View>
            <Text style={styles.logoText}>Finix HR</Text>
            <Text style={styles.logoSub}>Human Resource Management</Text>
          </View>
        </LinearGradient>

        {/* Card */}
        <View style={styles.card}>
          {mfaPending ? (
            <>
              <Text style={Typography.h2}>Two-Factor Auth</Text>
              <Text style={[Typography.body, { marginTop: 4, marginBottom: Spacing.xl }]}>
                Enter the 6-digit code from your authenticator app
              </Text>
              <Input
                label="Authentication Code"
                value={mfaCode}
                onChangeText={setMfaCode}
                keyboardType="numeric"
                maxLength={6}
                autoFocus
                placeholder="000000"
                leftIcon={<Ionicons name="shield-checkmark-outline" size={18} color={Colors.textTertiary} />}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button label="Verify Code" onPress={handleMfa} loading={isLoading} fullWidth style={{ marginTop: Spacing.xl }} />
            </>
          ) : (
            <>
              <Text style={Typography.h2}>Welcome back 👋</Text>
              <Text style={[Typography.body, { marginTop: 4, marginBottom: Spacing.xl }]}>
                Sign in to your Finix HR account
              </Text>

              <View style={{ gap: Spacing.md }}>
                <Input
                  label="Email Address"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  placeholder="you@company.com"
                  leftIcon={<Ionicons name="mail-outline" size={18} color={Colors.textTertiary} />}
                />
                <View>
                  <Input
                    label="Password"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPw}
                    autoComplete="password"
                    placeholder="••••••••"
                    leftIcon={<Ionicons name="lock-closed-outline" size={18} color={Colors.textTertiary} />}
                  />
                  <TouchableOpacity onPress={() => setShowPw(!showPw)} style={styles.eyeBtn}>
                    <Ionicons name={showPw ? "eye-off-outline" : "eye-outline"} size={18} color={Colors.textTertiary} />
                  </TouchableOpacity>
                </View>
              </View>

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Button label="Sign In" onPress={handleLogin} loading={isLoading} fullWidth style={{ marginTop: Spacing.xl }} />

              <Text style={[Typography.caption, { textAlign: "center", marginTop: Spacing.xl }]}>
                Secured with 256-bit encryption · Multi-factor authentication
              </Text>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  hero: { paddingTop: 80, paddingBottom: 64, alignItems: "center" },
  logoWrap: { alignItems: "center", gap: 10 },
  logoCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: "rgba(255,255,255,0.18)",
    justifyContent: "center", alignItems: "center",
    borderWidth: 1.5, borderColor: "rgba(255,255,255,0.35)",
  },
  logoText: { color: "#fff", fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  logoSub:  { color: "rgba(255,255,255,0.75)", fontSize: 13, fontWeight: "500" },
  card: {
    flex: 1, backgroundColor: Colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    marginTop: -28, padding: Spacing.xl, paddingTop: 32,
    ...Shadow.lg,
  },
  eyeBtn: { position: "absolute", right: 14, bottom: 13 },
  error: { color: Colors.danger, fontSize: 13, marginTop: Spacing.sm, fontWeight: "500" },
});

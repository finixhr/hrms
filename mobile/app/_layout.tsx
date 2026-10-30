// Root layout — gradient header, auth guard, push init, screen options

import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useAuthStore, type AuthUser } from "@/src/lib/auth";
import { getToken, rpc } from "@/src/lib/api";
import { registerForPushNotifications } from "@/src/lib/push";
import { initOutbox, resumeAfterLogin } from "@/src/lib/offline";
import { Colors } from "@/src/theme";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { user, setUser } = useAuthStore();
  const segments = useSegments();
  const router   = useRouter();

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        if (token) {
          // Session restore goes through the shared RPC client so behavior is
          // identical to every other call: an HTTP 401 clears the stale token
          // (rpc() does it) and the auth guard below routes to login, while a
          // temporary network failure throws before any state change — the
          // stored token survives and the next launch retries auth.me.
          const res = await rpc<{ user: AuthUser }>("auth.me", {});
          if (res?.user) setUser(res.user, token);
        }
      } catch { /* 401 already handled in rpc(); network errors keep the session */ } finally {
        await SplashScreen.hideAsync();
      }
      // M3 (T-12) — boot the offline outbox after the session attempt: loads
      // persisted punch records, wires connectivity/app-state sync triggers
      // and runs the first pass (entries recorded while offline sync here).
      // Runs regardless of login state — pending entries simply wait for a
      // live session (a 401 pauses the queue; resumeAfterLogin restarts it).
      await initOutbox().catch(() => {});
    })();
  }, []);

  // A live session (initial or after re-login) resumes the outbox: rpc()
  // reads the fresh token from the secure store on every submission.
  useEffect(() => {
    if (user?.id) resumeAfterLogin().catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    if (user) registerForPushNotifications().catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    const inAuth = segments[0] === "(auth)";
    if (!user && !inAuth) router.replace("/(auth)/login");
    else if (user && inAuth) router.replace("/(tabs)");
  }, [user, segments]);

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </>
  );
}

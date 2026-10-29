// Root layout — gradient header, auth guard, push init, screen options

import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useAuthStore } from "@/src/lib/auth";
import { getToken, getBaseUrl } from "@/src/lib/api";
import { registerForPushNotifications } from "@/src/lib/push";
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
          const res = await fetch(
            `${getBaseUrl()}/api/hrm`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "X-Requested-With": "XMLHttpRequest",
              },
              body: JSON.stringify({ action: "auth.me", payload: {} }),
            },
          );
          if (res.ok) {
            const data = (await res.json()) as { user: Parameters<typeof setUser>[0] };
            setUser(data.user, token);
          }
        }
      } catch { /* ignore — login screen will show */ } finally {
        await SplashScreen.hideAsync();
      }
    })();
  }, []);

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

// Root layout — gradient header, auth guard, push init, screen options

import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";
import { AppState } from "react-native";
import { useAuthStore, type AuthUser } from "@/src/lib/auth";
import { getToken, rpc, getBaseUrl } from "@/src/lib/api";
import { registerForPushNotifications, clearBadge } from "@/src/lib/push";
import { initOutbox, resumeAfterLogin } from "@/src/lib/offline";
import { Colors } from "@/src/theme";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { user, setUser, setCompany } = useAuthStore();
  const segments = useSegments();
  const router   = useRouter();

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        if (token) {
          // Session restore goes through the shared RPC client so behavior is
          // identical to every other call: an HTTP 401 clears the stale token
          // AND resets the whole auth store (rpc() → onUnauthorized →
          // auth.ts expireSession — MOB-1), so the auth guard below routes to
          // login, while a temporary network failure throws before any state
          // change — the stored token survives and the next launch retries
          // auth.me.
          const res = await rpc<{ user: AuthUser; company?: any }>("auth.me", {});
          if (res?.user) setUser(res.user, token);
          // MULTI-COMPANY — carry the server-resolved company context
          if (res?.company) setCompany(res.company);
        }
      } catch { /* 401 already handled in rpc() (store reset — MOB-1); network errors keep the session */ } finally {
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

  // FIN-008 (Phase 1) — push taps are WIRED: a notification response routes
  // the app instead of doing nothing. The server's push payloads carry the
  // deep link as data.view (the web SPA view key, e.g. "payroll" — see
  // audit.ts notify()); a bare tap lands on the home tab. The badge is
  // cleared on every response AND whenever the app comes to the foreground —
  // previously the launcher badge counted up forever because nothing ever
  // called setBadgeCountAsync(0).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      clearBadge().catch(() => {});
      const data = (response.notification.request.content as any).data || {};
      if (!user) return; // not signed in — the auth guard owns routing
      const appRoute = typeof data.appRoute === "string" ? data.appRoute : null;
      const webView = typeof data.view === "string" ? data.view.replace(/^\//, "") : null;
      const url = typeof data.url === "string" ? data.url : null;
      if (appRoute && /^\/.+/.test(appRoute)) {
        // explicit in-app route (e.g. "/(tabs)/leave") — route inside the app
        router.push(appRoute as any);
      } else if (webView) {
        // web SPA view key — the module launcher's browser flow (FIN-007)
        Linking.openURL(`${getBaseUrl()}/app?view=${encodeURIComponent(webView)}`).catch(() => {});
      } else if (url && /^https?:\/\//.test(url)) {
        // absolute URL — open in the system browser
        Linking.openURL(url).catch(() => {});
      } else {
        router.replace("/(tabs)");
      }
    });
    const stateSub = AppState.addEventListener("change", (s) => {
      if (s === "active") clearBadge().catch(() => {});
    });
    return () => { sub.remove(); stateSub.remove(); };
  }, [user, router]);

  useEffect(() => {
    // Auth guard. MOB-1 (2026-11-09 P1 wave): a 401 anywhere in the app now
    // resets the whole auth store (api.ts onUnauthorized → auth.ts
    // expireSession), so `user` actually flips null here and the app lands on
    // login — previously the token was cleared but the user object stayed
    // set, so this guard never fired and every screen looped on per-call
    // 401 errors until a manual sign-out or cold start.
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

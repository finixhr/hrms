// Push notification setup for Expo
// - Requests permission and gets Expo push token
// - Registers token with Finix HR server
// - Sets up foreground and background notification handlers

import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { rpc } from "./api";

// Stored so logout can unregister the exact token that was registered
// (push.unregisterDevice REQUIRES { token } — see routes/push.ts schema).
const PUSH_TOKEN_KEY = "finixhr_push_token";

// Show notifications even when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// ---------------------------------------------------------------------------
// Register device for push notifications
// ---------------------------------------------------------------------------

/** Resolve the EAS project the push token is minted for.
 *  `eas init` writes it to app.json → extra.eas.projectId; an
 *  EXPO_PUBLIC_EAS_PROJECT_ID env var can repoint a build without editing
 *  the manifest. Without a projectId expo-notifications cannot mint a
 *  REMOTE push token — fail closed instead of registering a dead token. */
function resolveProjectId(): string | null {
  const fromEnv = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  if (fromEnv && fromEnv.length > 10) return fromEnv;
  const fromManifest = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (fromManifest && fromManifest !== "YOUR_EAS_PROJECT_ID") return fromManifest;
  return null;
}

export async function registerForPushNotifications(): Promise<string | null> {
  // The whole flow is guarded: a push-registration failure must never break
  // app startup (T-15) — and it must never masquerade as success.
  try {
    if (!Device.isDevice) {
      console.warn("[push] Push notifications require a physical device");
      return null;
    }

    const projectId = resolveProjectId();
    if (!projectId) {
      console.warn(
        "[push] No EAS projectId configured (app.json extra.eas.projectId or " +
        "EXPO_PUBLIC_EAS_PROJECT_ID) — remote push tokens cannot be minted; skipping registration",
      );
      return null;
    }

    // Request permission
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.warn("[push] Push notification permission denied");
      return null;
    }

    // Android requires a notification channel
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Finix HR",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#1e40af",
      });
    }

    // Get Expo push token — minted against the configured EAS project
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const expoPushToken = tokenData.data;

    // Register with server
    // CONTRACT (routes/push.ts): platform is enum ["expo" | "fcm" | "apns"] —
    // an Expo push token registers as "expo" (the schema default). The old
    // code sent Platform.OS ("android"/"ios"), which failed enum validation,
    // so every registration was silently rejected.
    //
    // Honesty (T-15): a minted token the SERVER never accepted receives
    // nothing — report failure (null), store nothing, and let the next
    // app start retry. Never return the token as if registration succeeded.
    try {
      await rpc("push.registerDevice", { token: expoPushToken });
    } catch (err) {
      console.error("[push] Failed to register device token with the server:", err);
      return null;
    }
    await SecureStore.setItemAsync(PUSH_TOKEN_KEY, expoPushToken);
    console.log("[push] Registered device token:", expoPushToken);
    return expoPushToken;
  } catch (err) {
    // getExpoPushTokenAsync / permission / channel failures land here:
    // logged honestly, never fatal, no false success.
    console.warn("[push] Push notification registration failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Unregister device (logout) — sends the REQUIRED token field
// ---------------------------------------------------------------------------

export async function unregisterPushNotifications(): Promise<void> {
  // CONTRACT (routes/push.ts): { token } is required (min 10 chars). The old
  // logout path called this action with an EMPTY payload — validation failed
  // and the error was swallowed, so devices kept receiving tenant pushes
  // after the user signed out.
  let token: string | null = null;
  try {
    token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  } catch {
    return; // storage unavailable — nothing registered from this install
  }
  if (!token) return;
  try {
    await rpc("push.unregisterDevice", { token });
  } finally {
    await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY).catch(() => null);
  }
}

// ---------------------------------------------------------------------------
// Notification response handler (user tapped notification)
// ---------------------------------------------------------------------------

export function useNotificationHandler(
  onResponse: (notification: Notifications.NotificationResponse) => void,
): void {
  // This is called from the app entry — wire up the subscription
  Notifications.addNotificationResponseReceivedListener(onResponse);
}

// ---------------------------------------------------------------------------
// Clear badge count
// ---------------------------------------------------------------------------

export async function clearBadge(): Promise<void> {
  await Notifications.setBadgeCountAsync(0);
}

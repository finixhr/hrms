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

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    console.warn("[push] Push notifications require a physical device");
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

  // Get Expo push token
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const tokenOpts = projectId && projectId !== "YOUR_EAS_PROJECT_ID" ? { projectId } : undefined;
  const tokenData = await Notifications.getExpoPushTokenAsync(tokenOpts);
  const expoPushToken = tokenData.data;

  // Register with server
  // CONTRACT (routes/push.ts): platform is enum ["expo" | "fcm" | "apns"] —
  // an Expo push token registers as "expo" (the schema default). The old
  // code sent Platform.OS ("android"/"ios"), which failed enum validation,
  // so every registration was silently rejected.
  try {
    await rpc("push.registerDevice", { token: expoPushToken });
    await SecureStore.setItemAsync(PUSH_TOKEN_KEY, expoPushToken);
    console.log("[push] Registered device token:", expoPushToken);
  } catch (err) {
    console.error("[push] Failed to register device token:", err);
  }

  return expoPushToken;
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

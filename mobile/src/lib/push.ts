// Push notification setup for Expo
// - Requests permission and gets Expo push token
// - Registers token with Finix HR server
// - Sets up foreground and background notification handlers

import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { rpc } from "./api";

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
  try {
    await rpc("push.registerDevice", {
      token: expoPushToken,
      platform: Platform.OS, // "android" | "ios"
    });
    console.log("[push] Registered device token:", expoPushToken);
  } catch (err) {
    console.error("[push] Failed to register device token:", err);
  }

  return expoPushToken;
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

// Background location tracking for attendance
// Uses expo-location startLocationUpdatesAsync for background updates
// Calls tracking.location RPC with GPS coordinates

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { rpc } from "./api";

export const LOCATION_TASK_NAME = "finixhr-background-location";

// ---------------------------------------------------------------------------
// Define background task (must be at module top-level)
// ---------------------------------------------------------------------------

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error("[location] Background task error:", error.message);
    return;
  }
  const { locations } = data as { locations: Location.LocationObject[] };
  const latest = locations?.[0];
  if (!latest) return;

  try {
    // Schema S.trackingLocation (validation.ts:508): accuracyM / clientTimestamp /
    // clientEventId — the old `accuracy`/`timestamp` fields were silently
    // stripped by the server's Zod whitelist and never arrived.
    await rpc("tracking.location", {
      latitude: latest.coords.latitude,
      longitude: latest.coords.longitude,
      accuracyM: latest.coords.accuracy ?? null,
      clientTimestamp: new Date(latest.timestamp).toISOString(),
      clientEventId: `${LOCATION_TASK_NAME}-${latest.timestamp}`,
    });
  } catch (err) {
    // Non-fatal — server will retry via next update
    console.warn("[location] Failed to send location update:", err);
  }
});

// ---------------------------------------------------------------------------
// Request permissions and start tracking
// ---------------------------------------------------------------------------

export async function startLocationTracking(): Promise<boolean> {
  // Foreground permission first
  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
  if (fgStatus !== "granted") {
    console.warn("[location] Foreground location permission denied");
    return false;
  }

  // Background permission
  const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
  if (bgStatus !== "granted") {
    console.warn("[location] Background location permission denied — only foreground tracking active");
  }

  const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
  if (isRunning) return true;

  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 5 * 60 * 1000, // every 5 minutes
    distanceInterval: 100,        // or every 100 metres
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "Finix HR",
      notificationBody: "Location tracking active for attendance",
      notificationColor: "#1e40af",
    },
  });

  return true;
}

// ---------------------------------------------------------------------------
// Stop tracking
// ---------------------------------------------------------------------------

export async function stopLocationTracking(): Promise<void> {
  const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
  if (isRunning) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }
}

// ---------------------------------------------------------------------------
// One-shot current location for check-in
// ---------------------------------------------------------------------------

export async function getCurrentLocation(): Promise<{ latitude: number; longitude: number } | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return null;

  const loc = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });
  return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
}

/** One-shot location including accuracy in metres (geo-fence punch schema S.geoCheckin
 *  takes `accuracyM`). Returns null when permission is denied or no fix is available. */
export async function getLocationWithAccuracy(): Promise<{ latitude: number; longitude: number; accuracy?: number } | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return null;

  try {
    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    return {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      accuracy: loc.coords.accuracy ?? undefined,
    };
  } catch {
    return null;
  }
}

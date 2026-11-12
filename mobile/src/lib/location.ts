// One-shot location helpers for attendance check-in.
//
// FIN-008 (Phase 1) — this file used to also carry a BACKGROUND location
// tracking pipeline (TaskManager.defineTask + startLocationUpdatesAsync
// calling tracking.location every 5 minutes) that had ZERO call sites: the
// code requested ACCESS_BACKGROUND_LOCATION from every user while the task
// never fired — a permission demand for a feature that does not exist. The
// background pipeline is deleted (with the ACCESS_BACKGROUND_LOCATION
// manifest entry); it comes back when field-force tracking actually ships.
// What remains is exactly what attendance.tsx uses: foreground, one-shot,
// per-punch location.

import * as Location from "expo-location";

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

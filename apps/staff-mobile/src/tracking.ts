import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as Crypto from "expo-crypto";
import { db, kvGet, kvSet, nextSequence } from "./db";

export const LOCATION_TASK = "kisanroute-duty-location";

/**
 * Background task: runs only while location updates are started (between Start duty and End
 * duty). Writes raw fixes to the local queue; sync.flush() uploads them in batches.
 * Must be defined at module top level (imported from index.ts before the app renders).
 */
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const d = await db();
  const trip = await kvGet("active_trip_id");
  for (const l of data.locations) {
    await d.runAsync(
      "INSERT OR IGNORE INTO points (client_event_id, sequence, trip_id, device_time, lat, lon, accuracy_m, speed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [Crypto.randomUUID(), await nextSequence(), trip, new Date(l.timestamp).toISOString(), l.coords.latitude, l.coords.longitude, l.coords.accuracy ?? 9999, l.coords.speed ?? null],
    );
  }
  await kvSet("last_fix", new Date(data.locations[data.locations.length - 1]!.timestamp).toISOString());
  try {
    const { flush } = await import("./sync");
    await flush();
  } catch {
    /* retried by the sync loop */
  }
});

export type PermissionState = "background" | "foreground_only" | "denied";

export async function permissionState(): Promise<PermissionState> {
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return "denied";
  const bg = await Location.getBackgroundPermissionsAsync();
  return bg.granted ? "background" : "foreground_only";
}

/** Ask in two steps as the OS requires: while-in-use first, then "Allow all the time". */
export async function requestPermissions(): Promise<PermissionState> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return "denied";
  const bg = await Location.requestBackgroundPermissionsAsync();
  return bg.granted ? "background" : "foreground_only";
}

export async function startTracking(intervalS: number, distanceM: number): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: Math.max(10, intervalS) * 1000,
    distanceInterval: Math.max(5, distanceM),
    deferredUpdatesInterval: Math.max(10, intervalS) * 1000,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "KisanRoute: on duty",
      notificationBody: "Sharing your location until you end duty.",
      notificationColor: "#1f6f3a",
      killServiceOnDestroy: false,
    },
  });
  await kvSet("tracking", "on");
}

export async function stopTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  await kvSet("tracking", null);
  await kvSet("active_trip_id", null);
}

export async function isTracking(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

export async function setActiveTrip(tripId: string | null) {
  await kvSet("active_trip_id", tripId);
}

/** One fresh fix for an action (start/arrive). Null when unavailable — never fabricated. */
export async function currentFix(): Promise<{ lat: number; lon: number; accuracy_m: number; device_time: string } | null> {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    if (!fg.granted) return null;
    const l = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((r) => setTimeout(() => r(null), 15000)),
    ]);
    if (!l) return null;
    return { lat: l.coords.latitude, lon: l.coords.longitude, accuracy_m: l.coords.accuracy ?? 9999, device_time: new Date(l.timestamp).toISOString() };
  } catch {
    return null;
  }
}

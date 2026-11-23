import { MAX_CLOCK_DRIFT_S, MAX_PLAUSIBLE_SPEED_MS, type LocationQuality } from "./constants";

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres (haversine). Mirrors private.distance_m() in SQL. */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidCoordinate(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export type GeofenceResult =
  | { kind: "inside"; distance_m: number }
  | { kind: "outside"; distance_m: number }
  | { kind: "low_accuracy"; distance_m: number }
  | { kind: "no_device_fix" }
  | { kind: "no_target_pin" };

/**
 * Evaluate an arrival against the farmer pin. Low accuracy or outside the radius
 * never blocks the staff member; it requires a manual-override reason and is flagged.
 */
export function evaluateGeofence(
  device: (LatLon & { accuracy_m: number }) | null,
  target: LatLon | null,
  radiusM: number,
  lowAccuracyM: number,
): GeofenceResult {
  if (!target) return { kind: "no_target_pin" };
  if (!device) return { kind: "no_device_fix" };
  const d = distanceMeters(device, target);
  if (device.accuracy_m > lowAccuracyM) return { kind: "low_accuracy", distance_m: d };
  return d <= radiusM ? { kind: "inside", distance_m: d } : { kind: "outside", distance_m: d };
}

export const geofenceNeedsReason = (g: GeofenceResult) => g.kind !== "inside";

export interface RawPoint extends LatLon {
  device_time: string;
  accuracy_m: number;
}

/** Classify a GPS point relative to the previous accepted point. Mirrors SQL ingestion rules. */
export function classifyPoint(
  p: RawPoint,
  prev: RawPoint | null,
  nowMs: number,
  lowAccuracyM: number,
  staleAfterS = 86400,
): LocationQuality {
  const t = Date.parse(p.device_time);
  if (t - nowMs > MAX_CLOCK_DRIFT_S * 1000) return "clock_drift";
  if (nowMs - t > staleAfterS * 1000) return "stale";
  if (prev) {
    const dt = (t - Date.parse(prev.device_time)) / 1000;
    const d = distanceMeters(prev, p);
    if (dt > 0 && d / dt > MAX_PLAUSIBLE_SPEED_MS) return "teleport";
  }
  if (p.accuracy_m > lowAccuracyM) return "low_accuracy";
  return "ok";
}

export type Freshness = "live" | "stale" | "last_known" | "unavailable";

/**
 * Freshness label for a staff marker. "live" only while an active trip/duty exists
 * and the fix is newer than the stale threshold. Never "live" after a trip ended.
 */
export function freshness(
  receivedAt: string | null | undefined,
  onDuty: boolean,
  staleAfterS: number,
  nowMs: number = Date.now(),
): Freshness {
  if (!receivedAt) return "unavailable";
  const age = (nowMs - Date.parse(receivedAt)) / 1000;
  if (!onDuty) return "last_known";
  return age <= staleAfterS ? "live" : "stale";
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/**
 * Directions to an address when the farm has no pin yet. Sends only the address text to Google;
 * Google's match is approximate, so the app labels it that way.
 */
export function googleDirectionsToAddressUrl(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving`;
}

/** Google Maps directions URL (no API key needed). Only coordinates leave the system. */
export function googleDirectionsUrl(dest: LatLon, origin?: LatLon | null): string {
  // Built by hand (no URL class) so it works identically in browsers and React Native.
  const enc = (p: LatLon) => encodeURIComponent(`${p.lat.toFixed(6)},${p.lon.toFixed(6)}`);
  let u = `https://www.google.com/maps/dir/?api=1&destination=${enc(dest)}`;
  if (origin) u += `&origin=${enc(origin)}`;
  return `${u}&travelmode=driving`;
}

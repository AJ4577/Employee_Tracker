import { describe, expect, test } from "vitest";
import { analyzeRoute, frameAt, type TrackPoint } from "./route";

const T0 = Date.parse("2026-11-23T09:00:00Z");
const min = 60_000;
const P = (lat: number, lon: number, m: number): TrackPoint => ({ lat, lon, t: T0 + m * min, accuracy_m: 10, trip_id: null });

// Drive north ~1.1 km/min for 10 min, stay 20 min at a farm, drive on 5 min, 30-min data gap, 2 more points.
const route: TrackPoint[] = [
  ...Array.from({ length: 11 }, (_, i) => P(18.5 + i * 0.01, 73.8, i)),
  ...Array.from({ length: 5 }, (_, i) => P(18.6 + (i % 2) * 0.0002, 73.8, 11 + i * 5)), // stay (≈20 min)
  ...Array.from({ length: 5 }, (_, i) => P(18.61 + i * 0.01, 73.8, 32 + i)),
  P(18.7, 73.8, 70),
  P(18.71, 73.8, 71),
];

describe("route analysis", () => {
  test("detects the farm stop with arrival, departure and duration", () => {
    const a = analyzeRoute(route);
    expect(a.stops).toHaveLength(1);
    const s = a.stops[0]!;
    expect(s.lat).toBeCloseTo(18.6, 2);
    expect(s.duration_s).toBeGreaterThanOrEqual(20 * 60);
    expect(s.arrive).toBe(T0 + 10 * min);
  });
  test("distance excludes the data gap; gap is reported", () => {
    const a = analyzeRoute(route);
    expect(a.gaps).toHaveLength(1);
    expect(a.distance_m / 1000).toBeGreaterThan(15);
    expect(a.distance_m / 1000).toBeLessThan(18); // the 30-min jump is not counted as travel
  });
  test("short pauses are not stops", () => {
    const quick = [P(18.5, 73.8, 0), P(18.5, 73.8, 2), P(18.51, 73.8, 3)];
    expect(analyzeRoute(quick).stops).toHaveLength(0);
  });
  test("playback interpolates between real points and holds still during gaps", () => {
    const f = frameAt(route, T0 + 0.5 * min)!;
    expect(f.lat).toBeCloseTo(18.505, 3);
    expect(f.speed_kmh).toBeGreaterThan(60);
    const g = frameAt(route, T0 + 50 * min)!;
    expect(g.inGap).toBe(true);
    expect(g.lat).toBeCloseTo(18.65, 2); // last real point before the gap
  });
});

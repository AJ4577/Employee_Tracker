import { distanceMeters, type LatLon } from "./geo";

/** One recorded GPS fix (accepted points only). */
export interface TrackPoint extends LatLon {
  t: number; // epoch ms (device time)
  accuracy_m: number;
  trip_id: string | null;
}

export interface Stop extends LatLon {
  index: number; // 1-based, in time order
  arrive: number; // epoch ms
  depart: number; // epoch ms
  duration_s: number;
  points: number;
}

export interface RouteAnalysis {
  /** Distance along recorded points; legs across data gaps are not counted. */
  distance_m: number;
  moving_s: number;
  stopped_s: number;
  stops: Stop[];
  start: number | null;
  end: number | null;
  /** Gaps (ms) longer than gapS with no data, reported so nobody mistakes them for travel. */
  gaps: { from: number; to: number }[];
}

export interface AnalyzeOptions {
  /** Points within this radius of the stop's first point count as "staying". */
  stopRadiusM?: number;
  /** Minimum stay to count as a stop. */
  minStopS?: number;
  /** A pause in data longer than this is a gap (not travel). */
  gapS?: number;
}

/**
 * Stay-point detection + distance on real GPS points. No point is invented: distance and
 * movement are only counted between consecutive points that are close in time.
 */
export function analyzeRoute(points: TrackPoint[], opts: AnalyzeOptions = {}): RouteAnalysis {
  const R = opts.stopRadiusM ?? 100;
  const minStop = (opts.minStopS ?? 300) * 1000;
  const gap = (opts.gapS ?? 300) * 1000;
  const pts = [...points].sort((a, b) => a.t - b.t);
  const out: RouteAnalysis = { distance_m: 0, moving_s: 0, stopped_s: 0, stops: [], start: pts[0]?.t ?? null, end: pts.at(-1)?.t ?? null, gaps: [] };
  if (pts.length < 2) return out;

  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i]!.t - pts[i - 1]!.t;
    if (dt > gap) out.gaps.push({ from: pts[i - 1]!.t, to: pts[i]!.t });
    else out.distance_m += distanceMeters(pts[i - 1]!, pts[i]!);
  }

  let i = 0;
  while (i < pts.length) {
    let j = i;
    let sumLat = pts[i]!.lat;
    let sumLon = pts[i]!.lon;
    while (j + 1 < pts.length && distanceMeters(pts[i]!, pts[j + 1]!) <= R && pts[j + 1]!.t - pts[j]!.t <= gap) {
      j++;
      sumLat += pts[j]!.lat;
      sumLon += pts[j]!.lon;
    }
    const stay = pts[j]!.t - pts[i]!.t;
    if (j > i && stay >= minStop) {
      const n = j - i + 1;
      out.stops.push({ index: out.stops.length + 1, lat: sumLat / n, lon: sumLon / n, arrive: pts[i]!.t, depart: pts[j]!.t, duration_s: Math.round(stay / 1000), points: n });
      out.stopped_s += stay / 1000;
      i = j + 1;
    } else i++;
  }

  const covered = (out.end! - out.start!) / 1000 - out.gaps.reduce((s, g) => s + (g.to - g.from) / 1000, 0);
  out.moving_s = Math.max(0, Math.round(covered - out.stopped_s));
  out.stopped_s = Math.round(out.stopped_s);
  return out;
}

export interface PlaybackFrame extends LatLon {
  t: number;
  speed_kmh: number | null;
  travelled_m: number;
  inGap: boolean;
}

/**
 * Position at time t for playback: linear between two real consecutive points; during a data gap
 * the marker stays at the last real point (inGap = true) instead of sliding along an invented line.
 */
export function frameAt(points: TrackPoint[], t: number, gapS = 300): PlaybackFrame | null {
  if (!points.length) return null;
  if (t <= points[0]!.t) return { ...points[0]!, t, speed_kmh: null, travelled_m: 0, inGap: false };
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dt = b.t - a.t;
    const isGap = dt > gapS * 1000;
    const d = isGap ? 0 : distanceMeters(a, b);
    if (t <= b.t) {
      if (isGap) return { lat: a.lat, lon: a.lon, t, speed_kmh: null, travelled_m: travelled, inGap: true };
      const f = dt > 0 ? (t - a.t) / dt : 1;
      return {
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        t,
        speed_kmh: dt > 0 ? Math.round((d / (dt / 1000)) * 3.6) : null,
        travelled_m: travelled + d * f,
        inGap: false,
      };
    }
    travelled += d;
  }
  const last = points.at(-1)!;
  return { lat: last.lat, lon: last.lon, t, speed_kmh: null, travelled_m: travelled, inGap: false };
}

export function formatHm(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

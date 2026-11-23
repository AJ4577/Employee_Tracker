import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { analyzeRoute, distanceMeters, EVENT_LABEL, formatDistance, formatHm, formatInTz, frameAt, type FeedItem, type TrackPoint } from "@kisanroute/shared";
import { MapView, type MapMarker } from "../../map/MapView";
import { Button, Empty } from "../../ui/ui";

export interface DayVisit {
  id: string;
  farmer_name: string;
  target_lat: number | null;
  target_lon: number | null;
}

interface Props {
  points: TrackPoint[];
  visits: DayVisit[];
  events: FeedItem[];
  tz: string;
  fitKey: string;
  /** Live marker (latest position) to show when not playing. */
  liveMarker?: MapMarker | null;
  segments: [number, number][][];
}

type TimelineItem =
  | { kind: "stop"; t: number; stop: ReturnType<typeof analyzeRoute>["stops"][number]; near: string | null }
  | { kind: "event"; t: number; e: FeedItem }
  | { kind: "gap"; t: number; to: number };

const SPEEDS = [10, 30, 60, 120, 300];

/** Route summary, "where and how long" stops, visit timeline and playback of recorded GPS points. */
export function RouteHistory({ points, visits, events, tz, fitKey, liveMarker, segments }: Props) {
  const analysis = useMemo(() => analyzeRoute(points), [points]);
  const t0 = analysis.start ?? 0;
  const t1 = analysis.end ?? 0;
  const [t, setT] = useState(t0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const raf = useRef<number | null>(null);
  const last = useRef<number | null>(null);

  useEffect(() => {
    setT(t0);
    setPlaying(false);
  }, [t0, t1]);

  useEffect(() => {
    if (!playing) {
      if (raf.current) cancelAnimationFrame(raf.current);
      last.current = null;
      return;
    }
    const step = (now: number) => {
      const dt = last.current === null ? 0 : now - last.current;
      last.current = now;
      setT((cur) => {
        const next = cur + dt * speed;
        if (next >= t1) {
          setPlaying(false);
          return t1;
        }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, speed, t1]);

  const nearestVisit = (lat: number, lon: number) => {
    let best: { name: string; d: number } | null = null;
    for (const v of visits) {
      if (v.target_lat === null || v.target_lon === null) continue;
      const d = distanceMeters({ lat, lon }, { lat: v.target_lat, lon: v.target_lon });
      if (d <= 250 && (!best || d < best.d)) best = { name: v.farmer_name, d };
    }
    return best?.name ?? null;
  };

  const timeline: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [
      ...analysis.stops.map((s) => ({ kind: "stop" as const, t: s.arrive, stop: s, near: nearestVisit(s.lat, s.lon) })),
      ...events.map((e) => ({ kind: "event" as const, t: Date.parse(e.occurred_at), e })),
      ...analysis.gaps.map((g) => ({ kind: "gap" as const, t: g.from, to: g.to })),
    ];
    return items.sort((a, b) => a.t - b.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, events, visits]);

  const frame = points.length ? frameAt(points, t) : null;
  const showVehicle = points.length > 0 && (playing || t > t0);

  // Dotted connectors between recorded stretches (data gaps / trip changes); not a travelled road.
  const gapLines = useMemo(() => {
    const out: [number, number][][] = [];
    for (let i = 1; i < segments.length; i++) {
      const a = segments[i - 1]!.at(-1);
      const b = segments[i]![0];
      if (a && b) out.push([a, b]);
    }
    return out;
  }, [segments]);
  const first = points[0];
  const lastPt = points.at(-1);
  const clock = (ms: number) => formatInTz(new Date(ms).toISOString(), tz, { day: undefined, month: undefined, second: "2-digit" });

  const markers: MapMarker[] = [
    ...(first ? [{ id: "start", lat: first.lat, lon: first.lon, label: "Start", kind: "start" as const, badge: "S", popup: <div><strong>Start</strong><br />{clock(first.t)}</div> }] : []),
    ...(lastPt && points.length > 1 ? [{ id: "end", lat: lastPt.lat, lon: lastPt.lon, label: "Last point", kind: "end" as const, badge: "E", popup: <div><strong>Last point</strong><br />{clock(lastPt.t)}</div> }] : []),
    ...visits
      .filter((v) => v.target_lat !== null)
      .map((v) => ({ id: `v-${v.id}`, lat: v.target_lat!, lon: v.target_lon!, label: v.farmer_name, kind: "farmer" as const })),
    ...analysis.stops.map((s) => ({
      id: `s-${s.index}`,
      lat: s.lat,
      lon: s.lon,
      label: `Stop ${s.index}`,
      kind: "stop" as const,
      badge: String(s.index),
      popup: (
        <div>
          <strong>Stop {s.index}</strong>
          {nearestVisit(s.lat, s.lon) ? <> · near {nearestVisit(s.lat, s.lon)}</> : null}
          <br />
          {formatInTz(new Date(s.arrive).toISOString(), tz, { day: undefined, month: undefined })} – {formatInTz(new Date(s.depart).toISOString(), tz, { day: undefined, month: undefined })} ({formatHm(s.duration_s)})
        </div>
      ),
    })),
    ...(showVehicle && frame ? [{ id: "vehicle", lat: frame.lat, lon: frame.lon, label: "Staff (playback)", kind: "vehicle" as const }] : liveMarker ? [liveMarker] : []),
  ];

  if (!points.length) {
    return <Empty title="No GPS points recorded for this period">The staff member may have been off duty, in limited mode, denied location permission or offline. Nothing is drawn without real points.</Empty>;
  }

  const time = (ms: number) => formatInTz(new Date(ms).toISOString(), tz, { day: undefined, month: undefined, second: "2-digit" });

  return (
    <div className="route-history">
      <div className="route-summary">
        <div><strong>{formatDistance(analysis.distance_m)}</strong><span className="muted small">travelled</span></div>
        <div><strong>{formatHm(analysis.moving_s)}</strong><span className="muted small">moving</span></div>
        <div><strong>{formatHm(analysis.stopped_s)}</strong><span className="muted small">stopped ({analysis.stops.length})</span></div>
        <div><strong>{time(t0)}</strong><span className="muted small">first point</span></div>
        <div><strong>{time(t1)}</strong><span className="muted small">last point</span></div>
      </div>

      <div className="route-body">
        <div className="route-map">
          <MapView markers={markers} routes={segments} gapLines={gapLines} height={480} title="Route playback map" fitKey={fitKey} />
          <div className="playback" aria-label="Route playback">
            <Button className="btn-sm" onClick={() => { if (t >= t1) setT(t0); setPlaying((p) => !p); }} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "⏸ Pause" : "▶ Play"}
            </Button>
            <Button variant="secondary" className="btn-sm" onClick={() => { setPlaying(false); setT(t0); }} aria-label="Restart">↺</Button>
            <select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
            <input type="range" aria-label="Playback position" min={t0} max={t1} step={1000} value={Math.round(t)} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} />
            <div className="playback-readout">
              <strong>{time(t)}</strong>
              <span>{frame?.inGap ? "no data (gap)" : frame?.speed_kmh !== null && frame?.speed_kmh !== undefined ? `${frame.speed_kmh} km/h` : "—"}</span>
              <span>{formatDistance(frame?.travelled_m ?? 0)}</span>
            </div>
          </div>
          <p className="route-legend small">
            <span><i className="lg-line" /> Recorded route (arrows show direction)</span>
            <span><i className="lg-gap" /> No GPS data, actual road not known</span>
            <span><i className="lg-dot lg-start" /> Start</span>
            <span><i className="lg-dot lg-end" /> Last point</span>
            <span><i className="lg-dot lg-stop" /> Stopped 5+ min</span>
          </p>
          {analysis.gaps.length ? (
            <p className="small text-warn">
              {analysis.gaps.length} period(s) without location ({formatHm(analysis.gaps.reduce((sum, gp) => sum + (gp.to - gp.from) / 1000, 0))} in total). This happens when the staff page was closed, the phone was locked or GPS was off. For a continuous line the staff must keep KisanRoute open while travelling (or use the mobile app).
            </p>
          ) : null}
        </div>

        <ol className="route-timeline">
          {timeline.map((it, i) =>
            it.kind === "stop" ? (
              <li key={`s${i}`} className="rt-stop">
                <button type="button" onClick={() => { setPlaying(false); setT(it.stop.arrive); }}>
                  <span className="rt-badge">{it.stop.index}</span>
                  <span>
                    <strong>Stopped {formatHm(it.stop.duration_s)}</strong>
                    {it.near ? <> · near {it.near}</> : null}
                    <span className="small muted block">{time(it.stop.arrive)} – {time(it.stop.depart)}</span>
                  </span>
                </button>
              </li>
            ) : it.kind === "event" ? (
              <li key={`e${i}`} className={it.e.flagged ? "rt-event flagged" : "rt-event"}>
                <button type="button" onClick={() => { setPlaying(false); setT(Math.min(Math.max(it.t, t0), t1)); }}>
                  <span className="rt-dot" aria-hidden />
                  <span>
                    <strong>{EVENT_LABEL[it.e.event_type] ?? it.e.event_type}</strong> · <Link to={`/admin/visits/${it.e.visit_id}`} onClick={(ev) => ev.stopPropagation()}>{it.e.farmer_name}</Link>
                    <span className="small muted block">{time(it.t)}{it.e.reason ? ` · “${it.e.reason}”` : ""}</span>
                  </span>
                </button>
              </li>
            ) : (
              <li key={`g${i}`} className="rt-gap">
                <span className="small">No location data {time(it.t)} – {time(it.to)} ({formatHm((it.to - it.t) / 1000)})</span>
              </li>
            ),
          )}
        </ol>
      </div>
    </div>
  );
}

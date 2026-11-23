import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { distanceMeters } from "@kisanroute/shared";
import { useAuth } from "./auth";
import { rpc, ApiError } from "./api";

/**
 * Browser live-location sharing for staff during a 'tracking' duty.
 * Works only while the KisanRoute page is open in the foreground: browsers stop location updates
 * when the tab is closed, the screen locks or another app is in front. Nothing is invented when
 * no fix arrives; the admin map then shows Stale / Last known.
 */
export type WebTrackState = "off" | "waiting" | "on" | "denied" | "unsupported" | "error" | "other_tab";

export interface WebTrackStatus {
  state: WebTrackState;
  lastFixAt: string | null;
  accuracyM: number | null;
  lastSyncAt: string | null;
  pending: number;
}

const Ctx = createContext<WebTrackStatus>({ state: "off", lastFixAt: null, accuracyM: null, lastSyncAt: null, pending: 0 });
export const useWebTracking = () => useContext(Ctx);

interface Pt {
  client_event_id: string;
  sequence: number;
  device_time: string;
  lat: number;
  lon: number;
  accuracy_m: number;
  speed_ms: number | null;
}

export function WebTrackerProvider({ children }: { children: ReactNode }) {
  const { me, settings, refreshMe } = useAuth();
  const active = me?.profile.role === "staff" && me.duty?.mode === "tracking";
  const tripRef = useRef<string | null>(null);
  tripRef.current = me?.active_trip?.id ?? null;
  const [status, setStatus] = useState<WebTrackStatus>({ state: "off", lastFixAt: null, accuracyM: null, lastSyncAt: null, pending: 0 });

  useEffect(() => {
    if (!active) {
      setStatus((s) => ({ ...s, state: "off", pending: 0 }));
      return;
    }
    if (!("geolocation" in navigator)) {
      setStatus((s) => ({ ...s, state: "unsupported" }));
      return;
    }
    // Only one browser tab may track at a time (two tabs produced duplicate points).
    const run = (): (() => void) => {
    setStatus((s) => ({ ...s, state: "waiting" }));
    const queue: Pt[] = [];
    let last: { lat: number; lon: number; t: number } | null = null;
    let stopped = false;
    let lastSyncDone = false;
    let flushing = false;
    const minGapMs = Math.max(10, settings.sample_interval_s) * 1000;
    const minMoveM = Math.max(5, settings.sample_distance_m);

    const watchId = navigator.geolocation.watchPosition(
      (p) => {
        const fix = { lat: p.coords.latitude, lon: p.coords.longitude, t: p.timestamp };
        setStatus((s) => ({ ...s, state: "on", lastFixAt: new Date(p.timestamp).toISOString(), accuracyM: p.coords.accuracy }));
        // Sample by time or distance (configurable in Settings) instead of every raw update.
        if (last && fix.t - last.t < minGapMs && distanceMeters(last, fix) < minMoveM) return;
        last = fix;
        queue.push({
          client_event_id: crypto.randomUUID(),
          sequence: Math.max(0, Math.floor(p.timestamp / 1000) - 1_700_000_000),
          device_time: new Date(p.timestamp).toISOString(),
          lat: fix.lat,
          lon: fix.lon,
          accuracy_m: Math.round(p.coords.accuracy * 10) / 10,
          speed_ms: p.coords.speed ?? null,
        });
        setStatus((s) => ({ ...s, pending: queue.length }));
        if (queue.length === 1 && !lastSyncDone) flush(); // first point goes out immediately
      },
      (err) => setStatus((s) => ({ ...s, state: err.code === err.PERMISSION_DENIED ? "denied" : "error" })),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );

    async function flush() {
      if (flushing || stopped || !queue.length || !navigator.onLine) return;
      flushing = true;
      const batch = queue.splice(0, 200);
      try {
        const r = await rpc<{ server_time: string }>("ingest_location_batch", { p_points: batch, p_trip: tripRef.current });
        lastSyncDone = true;
        setStatus((s) => ({ ...s, lastSyncAt: r.server_time, pending: queue.length }));
      } catch (e) {
        const code = (e as ApiError).code;
        if (code === "network") queue.unshift(...batch); // retry later, same client_event_ids
        else if (code === "tracking_disabled" || code === "duty_not_started" || code === "forbidden") {
          stopped = true;
          refreshMe();
        }
        setStatus((s) => ({ ...s, pending: queue.length }));
      } finally {
        flushing = false;
      }
    }
    const iv = setInterval(flush, 20000);
    const onOnline = () => flush();
    window.addEventListener("online", onOnline);

    // Keep the screen awake while sharing (where supported) so updates keep flowing.
    let lock: { release: () => Promise<void> } | null = null;
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    wl?.request("screen").then((l) => (lock = l)).catch(() => {});

    return () => {
      navigator.geolocation.clearWatch(watchId);
      clearInterval(iv);
      window.removeEventListener("online", onOnline);
      flush();
      stopped = true;
      lock?.release().catch(() => {});
    };
    };

    const locks = (navigator as Navigator & { locks?: { request: (name: string, opts: { signal: AbortSignal }, cb: () => Promise<void>) => Promise<void> } }).locks;
    const ctrl = new AbortController();
    let stop: (() => void) | null = null;
    let release: (() => void) | null = null;
    if (locks?.request) {
      setStatus((s) => ({ ...s, state: "other_tab" }));
      locks
        .request("kisanroute-location-tracker", { signal: ctrl.signal }, () =>
          new Promise<void>((res) => {
            release = res;
            stop = run();
          }),
        )
        .catch(() => {});
    } else stop = run();
    return () => {
      ctrl.abort();
      stop?.();
      release?.();
    };
  }, [active, settings.sample_interval_s, settings.sample_distance_m, refreshMe]);

  return (
    <Ctx.Provider value={status}>
      {children}
      {active ? (
        <div className={`track-pill track-${status.state}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden />
          {status.state === "on"
            ? `Sharing live location${status.accuracyM ? ` · ±${status.accuracyM >= 1000 ? `${(status.accuracyM / 1000).toFixed(1)} km` : `${Math.round(status.accuracyM)} m`}` : ""}`
            : status.state === "waiting"
              ? "Getting your location…"
              : status.state === "denied"
                ? "Location permission denied"
                : status.state === "other_tab"
                  ? "Location is being shared from another KisanRoute tab"
                  : "Location unavailable"}
        </div>
      ) : null}
    </Ctx.Provider>
  );
}

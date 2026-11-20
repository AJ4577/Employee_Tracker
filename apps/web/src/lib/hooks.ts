import { useEffect, useRef, useState } from "react";

export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A stable idempotency key per "intent"; call reset() after a confirmed success. */
export function useIdempotencyKey(): [string, () => void] {
  const ref = useRef(crypto.randomUUID());
  const [, force] = useState(0);
  return [
    ref.current,
    () => {
      ref.current = crypto.randomUUID();
      force((x) => x + 1);
    },
  ];
}

/** Ticks every `ms` so relative times ("2 min ago") and freshness labels stay current. */
export function useNow(ms = 15000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export interface DeviceFix {
  lat: number;
  lon: number;
  accuracy_m: number;
  device_time: string;
}

/**
 * One-shot browser position for a status action (start/arrive). Returns null if the user
 * denies permission or no fix is available — the server then requires a manual reason.
 * The web app never tracks continuously; background tracking is the mobile app's job.
 */
export function getBrowserFix(timeoutMs = 12000): Promise<DeviceFix | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: p.coords.accuracy, device_time: new Date(p.timestamp).toISOString() }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}

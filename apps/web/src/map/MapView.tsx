import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMap, useMapEvents } from "react-leaflet";
import L, { type LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useAuth } from "../lib/auth";
import { callFunction, ApiError } from "../lib/api";
import { useDebounced } from "../lib/hooks";

import type { LocalSearchResult, MapMarker, MapProps } from "./types";
import { GoogleMapView, hasGoogleMaps } from "./GoogleMapView";

export type { LocalSearchResult, MapMarker, MapProps } from "./types";

const DEFAULT_CENTER: [number, number] = [20.5937, 78.9629]; // India

const icon = (kind: MapMarker["kind"], label: string, badge?: string) =>
  L.divIcon({
    className: "",
    html: ({ walk: "🚶", bike: "🏍️", car: "🚗" } as Record<string, string>)[kind]
      ? `<div class="pin-vehicle-emoji" aria-label="${label.replace(/[<>"&]/g, "")}">${({ walk: "🚶", bike: "🏍️", car: "🚗" } as Record<string, string>)[kind]}</div>`
      : `<div class="pin pin-${kind}" aria-label="${label.replace(/[<>"&]/g, "")}">${badge ? `<span class="pin-badge">${badge.replace(/[<>"&]/g, "")}</span>` : ""}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
    popupAnchor: [0, -24],
  });

function FitTo({ markers, routes, center, zoom, fitKey }: Pick<MapProps, "markers" | "routes" | "center" | "zoom" | "fitKey">) {
  const map = useMap();
  const auto = useMemo(() => JSON.stringify([center, markers?.map((m) => [m.lat, m.lon]), routes?.map((r) => r.length)]), [center, markers, routes]);
  const key = fitKey ?? auto;
  useEffect(() => {
    if (center) {
      map.setView(center, zoom ?? 15);
      return;
    }
    const pts: [number, number][] = [...(markers ?? []).map((m) => [m.lat, m.lon] as [number, number]), ...(routes ?? []).flat()];
    if (pts.length === 1) map.setView(pts[0]!, 14);
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

function Recenter({ to }: { to: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (to) map.setView(to, Math.max(map.getZoom(), 15));
  }, [to, map]);
  return null;
}

function PickHandler({ onPick }: { onPick?: (lat: number, lon: number) => void }) {
  useMapEvents({ click: (e) => onPick?.(e.latlng.lat, e.latlng.lng) });
  return null;
}

function Resize({ dep }: { dep: unknown }) {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(t);
  }, [dep, map]);
  return null;
}

/** Google Maps when VITE_GOOGLE_MAPS_API_KEY is set; otherwise the configured tile provider via Leaflet. */
export function MapView(props: MapProps) {
  return hasGoogleMaps ? <GoogleMapView {...props} /> : <LeafletMapView {...props} />;
}

function LeafletMapView({ markers = [], routes, center, zoom, height = 360, onPick, localSearch, searchable = true, title = "Map", legend, fitKey, gapLines, estimatedRoutes }: MapProps) {
  const { settings } = useAuth();
  const [full, setFull] = useState(false);
  const [searchPin, setSearchPin] = useState<LocalSearchResult | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    document.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [full]);

  const all = searchPin ? [...markers, { id: "search", lat: searchPin.lat, lon: searchPin.lon, label: searchPin.label, kind: "search" as const }] : markers;

  return (
    <div ref={wrapRef} className={`mapwrap ${full ? "mapwrap-full" : ""}`} style={full ? undefined : { height }} role="region" aria-label={title}>
      <div className="map-toolbar">
        {searchable ? <MapSearch localSearch={localSearch} onSelect={setSearchPin} /> : <span />}
        <button className="map-btn" onClick={() => setFull((f) => !f)} aria-label={full ? "Exit full screen map" : "Open full screen map"}>
          {full ? "✕ Close" : "⤢ Full screen"}
        </button>
      </div>
      <MapContainer center={center ?? DEFAULT_CENTER} zoom={center ? zoom ?? 15 : 5} className="map" scrollWheelZoom={full} attributionControl>
        <TileLayer url={settings.map_tile_url} attribution={settings.map_tile_attribution} maxZoom={19} />
        <FitTo markers={markers} routes={routes} center={center} zoom={zoom} fitKey={fitKey} />
        <Recenter to={searchPin ? [searchPin.lat, searchPin.lon] : null} />
        <Resize dep={full} />
        <PickHandler onPick={onPick} />
        {(routes ?? []).filter((r) => r.length > 1).map((r, i) => (
          <Polyline key={`r${i}`} positions={r as LatLngExpression[]} pathOptions={{ color: "#1a73e8", weight: 6, opacity: 0.95 }} />
        ))}
        {(estimatedRoutes ?? []).filter((r) => r.length > 1).map((r, i) => (
          <Polyline key={`e${i}`} positions={r as LatLngExpression[]} pathOptions={{ color: "#1a73e8", weight: 5, opacity: 0.4 }} />
        ))}
        {(gapLines ?? []).map((gl, i) => (
          <Polyline key={`g${i}`} positions={gl as LatLngExpression[]} pathOptions={{ color: "#6b7280", weight: 3, opacity: 0.85, dashArray: "4 8" }} />
        ))}
        {all.map((m) => (
          <Marker key={m.id} position={[m.lat, m.lon]} icon={icon(m.kind, m.label, m.badge)} title={m.label} alt={m.label}>
            <Popup>{m.popup ?? <strong>{m.label}</strong>}</Popup>
          </Marker>
        ))}
        {all
          .filter((m) => m.accuracy_m && m.accuracy_m > 15 && m.kind.startsWith("staff"))
          .map((m) => (
            <Circle key={`acc-${m.id}`} center={[m.lat, m.lon]} radius={m.accuracy_m!} pathOptions={{ color: "#2b6cb0", weight: 1, fillOpacity: 0.08 }} />
          ))}
      </MapContainer>
      {legend ? <div className="map-legend">{legend}</div> : null}
    </div>
  );
}

function MapSearch({ localSearch, onSelect }: { localSearch?: (q: string) => LocalSearchResult[]; onSelect: (r: LocalSearchResult | null) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<LocalSearchResult[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dq = useDebounced(q, 450);
  const local = useMemo(() => (localSearch && q.trim().length >= 2 ? localSearch(q.trim()).slice(0, 6) : []), [q, localSearch]);

  useEffect(() => {
    setRemote([]);
    setMsg(null);
    if (dq.trim().length < 3) return;
    let cancelled = false;
    setBusy(true);
    callFunction<{ results: { lat: number; lon: number; label: string }[] }>("places", { q: dq.trim() })
      .then((r) => {
        if (cancelled) return;
        setRemote(r.results.map((x, i) => ({ id: `p${i}`, label: x.label, sub: "Approximate address match", lat: x.lat, lon: x.lon })));
        if (r.results.length === 0) setMsg("No address matches.");
      })
      .catch((e: ApiError) => !cancelled && setMsg(e.code === "provider_not_configured" ? "Address search isn't configured yet (farmer search still works)." : e.message))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [dq]);

  const results = [...local, ...remote];
  return (
    <div className="map-search">
      <input
        type="search"
        placeholder="Search place or farmer"
        aria-label="Search place or farmer on map"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && q.trim().length >= 2 ? (
        <ul className="map-results" role="listbox">
          {busy ? <li className="muted">Searching…</li> : null}
          {results.map((r) => (
            <li key={r.id}>
              <button
                role="option"
                aria-selected={false}
                onClick={() => {
                  onSelect(r);
                  setOpen(false);
                }}
              >
                <span>{r.label}</span>
                {r.sub ? <small className="muted">{r.sub}</small> : null}
              </button>
            </li>
          ))}
          {msg ? <li className="muted">{msg}</li> : null}
          <li>
            <button
              className="muted"
              onClick={() => {
                onSelect(null);
                setQ("");
                setOpen(false);
              }}
            >
              Clear search
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

export function staffMarkerKind(f: "live" | "stale" | "last_known" | "unavailable"): MapMarker["kind"] {
  return f === "live" ? "staff-live" : f === "stale" ? "staff-stale" : "staff-last";
}

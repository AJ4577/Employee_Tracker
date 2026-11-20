import { useEffect, useMemo, useRef, useState } from "react";
import { APIProvider, InfoWindow, Map, Marker, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { useDebounced } from "../lib/hooks";
import type { LocalSearchResult, MapMarker, MapProps } from "./types";

const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
export const hasGoogleMaps = !!KEY;

const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 }; // India

const COLORS: Record<MapMarker["kind"], string> = {
  farmer: "#1f6f3a",
  "farmer-approx": "#e0a100",
  "staff-live": "#1d6fd6",
  "staff-stale": "#e0a100",
  "staff-last": "#7a7a7a",
  search: "#c2185b",
  me: "#1d6fd6",
  pick: "#6b21a8",
};

function pinIcon(kind: MapMarker["kind"]): google.maps.Icon {
  const c = COLORS[kind];
  const round = kind.startsWith("staff") || kind === "me";
  const svg = round
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="${c}" stroke="#fff" stroke-width="3"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="38" viewBox="0 0 28 38"><path d="M14 1C7 1 1.5 6.4 1.5 13.3 1.5 23 14 37 14 37s12.5-14 12.5-23.7C26.5 6.4 21 1 14 1z" fill="${c}" stroke="#fff" stroke-width="2.5"/><circle cx="14" cy="13.5" r="4.5" fill="#fff"/></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: round ? new google.maps.Size(26, 26) : new google.maps.Size(28, 38),
    anchor: round ? new google.maps.Point(13, 13) : new google.maps.Point(14, 37),
  };
}

/** Fit to markers/routes, or center on a given point. Re-runs only when the content actually changes. */
function FitTo({ markers, routes, center, zoom }: Pick<MapProps, "markers" | "routes" | "center" | "zoom">) {
  const map = useMap();
  const key = useMemo(() => JSON.stringify([center, markers?.map((m) => [m.lat, m.lon]), routes?.map((r) => r.length)]), [center, markers, routes]);
  useEffect(() => {
    if (!map) return;
    if (center) {
      map.setCenter({ lat: center[0], lng: center[1] });
      map.setZoom(zoom ?? 16);
      return;
    }
    const pts = [...(markers ?? []).map((m) => ({ lat: m.lat, lng: m.lon })), ...(routes ?? []).flat().map(([lat, lng]) => ({ lat, lng }))];
    if (pts.length === 1) {
      map.setCenter(pts[0]!);
      map.setZoom(15);
    } else if (pts.length > 1) {
      const b = new google.maps.LatLngBounds();
      pts.forEach((p) => b.extend(p));
      map.fitBounds(b, 40);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

/** Recorded GPS trail: one polyline per segment, never joined across gaps. */
function Routes({ routes }: { routes?: [number, number][][] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !routes) return;
    const lines = routes
      .filter((r) => r.length > 1)
      .map(
        (r) =>
          new google.maps.Polyline({
            map,
            path: r.map(([lat, lng]) => ({ lat, lng })),
            strokeColor: "#1f6f3a",
            strokeOpacity: 0.9,
            strokeWeight: 4,
          }),
      );
    return () => lines.forEach((l) => l.setMap(null));
  }, [map, routes]);
  return null;
}

function AccuracyCircles({ markers }: { markers: MapMarker[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    const circles = markers
      .filter((m) => m.accuracy_m && m.accuracy_m > 15 && m.kind.startsWith("staff"))
      .map((m) => new google.maps.Circle({ map, center: { lat: m.lat, lng: m.lon }, radius: m.accuracy_m!, strokeColor: "#2b6cb0", strokeWeight: 1, fillColor: "#2b6cb0", fillOpacity: 0.08, clickable: false }));
    return () => circles.forEach((c) => c.setMap(null));
  }, [map, markers]);
  return null;
}

function Recenter({ to }: { to: LocalSearchResult | null }) {
  const map = useMap();
  useEffect(() => {
    if (map && to) {
      map.panTo({ lat: to.lat, lng: to.lon });
      map.setZoom(Math.max(map.getZoom() ?? 15, 16));
    }
  }, [map, to]);
  return null;
}

function GoogleSearch({ localSearch, onSelect }: { localSearch?: (q: string) => LocalSearchResult[]; onSelect: (r: LocalSearchResult | null) => void }) {
  const geocoding = useMapsLibrary("geocoding");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<LocalSearchResult[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const dq = useDebounced(q, 450);
  const local = useMemo(() => (localSearch && q.trim().length >= 2 ? localSearch(q.trim()).slice(0, 6) : []), [q, localSearch]);

  useEffect(() => {
    setRemote([]);
    setMsg(null);
    if (!geocoding || dq.trim().length < 3) return;
    let cancelled = false;
    new geocoding.Geocoder()
      .geocode({ address: dq.trim(), region: "IN" })
      .then((r) => {
        if (cancelled) return;
        setRemote(r.results.slice(0, 6).map((x, i) => ({ id: `g${i}`, label: x.formatted_address, sub: "Google result — approximate until confirmed", lat: x.geometry.location.lat(), lon: x.geometry.location.lng() })));
      })
      .catch((e: { code?: string }) => !cancelled && setMsg(e?.code === "ZERO_RESULTS" ? "No places found." : "Place search unavailable (enable Geocoding API for the key)."));
    return () => {
      cancelled = true;
    };
  }, [dq, geocoding]);

  const results = [...local, ...remote];
  return (
    <div className="map-search">
      <input type="search" placeholder="Search village, place or farmer" aria-label="Search place or farmer on map" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      {open && q.trim().length >= 2 ? (
        <ul className="map-results" role="listbox">
          {results.map((r) => (
            <li key={r.id}>
              <button role="option" aria-selected={false} onClick={() => { onSelect(r); setOpen(false); }}>
                <span>{r.label}</span>
                {r.sub ? <small className="muted">{r.sub}</small> : null}
              </button>
            </li>
          ))}
          {msg ? <li className="muted">{msg}</li> : null}
          <li>
            <button className="muted" onClick={() => { onSelect(null); setQ(""); setOpen(false); }}>Clear search</button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

export function GoogleMapView({ markers = [], routes, center, zoom, height = 360, onPick, localSearch, searchable = true, title = "Map", legend }: MapProps) {
  const [full, setFull] = useState(false);
  const [searchPin, setSearchPin] = useState<LocalSearchResult | null>(null);
  const [openInfo, setOpenInfo] = useState<string | null>(null);
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

  const all: MapMarker[] = searchPin ? [...markers, { id: "search", lat: searchPin.lat, lon: searchPin.lon, label: searchPin.label, kind: "search" }] : markers;
  const info = all.find((m) => m.id === openInfo);

  return (
    <APIProvider apiKey={KEY!} region="IN" language="en">
      <div ref={wrapRef} className={`mapwrap ${full ? "mapwrap-full" : ""}`} style={full ? undefined : { height }} role="region" aria-label={title}>
        <div className="map-toolbar map-toolbar-google">
          {searchable ? <GoogleSearch localSearch={localSearch} onSelect={setSearchPin} /> : <span />}
          <button className="map-btn" onClick={() => setFull((f) => !f)} aria-label={full ? "Exit full screen map" : "Open full screen map"}>
            {full ? "✕ Close" : "⤢ Full screen"}
          </button>
        </div>
        <Map
          className="map"
          defaultCenter={center ? { lat: center[0], lng: center[1] } : DEFAULT_CENTER}
          defaultZoom={center ? zoom ?? 16 : 5}
          minZoom={3}
          maxZoom={21}
          gestureHandling={full ? "greedy" : "cooperative"}
          mapTypeControl
          mapTypeControlOptions={{ position: 9 /* LEFT_BOTTOM */ }}
          streetViewControl={false}
          fullscreenControl={false}
          clickableIcons={false}
          onClick={(e) => {
            const ll = e.detail.latLng;
            if (ll && onPick) onPick(ll.lat, ll.lng);
          }}
        >
          <FitTo markers={markers} routes={routes} center={center} zoom={zoom} />
          <Recenter to={searchPin} />
          <Routes routes={routes} />
          <AccuracyCircles markers={all} />
          {all.map((m) => (
            <Marker key={m.id} position={{ lat: m.lat, lng: m.lon }} title={m.label} icon={pinIcon(m.kind)} onClick={() => setOpenInfo(m.id)} />
          ))}
          {info ? (
            <InfoWindow position={{ lat: info.lat, lng: info.lon }} pixelOffset={[0, -30]} onCloseClick={() => setOpenInfo(null)}>
              <div className="map-info">{info.popup ?? <strong>{info.label}</strong>}</div>
            </InfoWindow>
          ) : null}
        </Map>
        {legend ? <div className="map-legend">{legend}</div> : null}
      </div>
    </APIProvider>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { APIProvider, InfoWindow, Map, Marker, useApiIsLoaded, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { useDebounced } from "../lib/hooks";
import { distanceMeters } from "@kisanroute/shared";
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
  stop: "#c2410c",
  vehicle: "#111827",
  start: "#16a34a",
  end: "#dc2626",
};

function pinIcon(kind: MapMarker["kind"]): google.maps.Icon {
  const c = COLORS[kind];
  const round = kind.startsWith("staff") || kind === "me" || kind === "stop" || kind === "vehicle" || kind === "start" || kind === "end";
  const svg = round
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="${c}" stroke="#fff" stroke-width="3"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="38" viewBox="0 0 28 38"><path d="M14 1C7 1 1.5 6.4 1.5 13.3 1.5 23 14 37 14 37s12.5-14 12.5-23.7C26.5 6.4 21 1 14 1z" fill="${c}" stroke="#fff" stroke-width="2.5"/><circle cx="14" cy="13.5" r="4.5" fill="#fff"/></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: round ? new google.maps.Size(26, 26) : new google.maps.Size(28, 38),
    anchor: round ? new google.maps.Point(13, 13) : new google.maps.Point(14, 37),
    labelOrigin: round ? new google.maps.Point(13, 13) : new google.maps.Point(14, 14),
  };
}

/** google.maps.* exists only after the Maps script loads; never build icons before that. */
function PinMarker({ m, onClick }: { m: MapMarker; onClick: () => void }) {
  const loaded = useApiIsLoaded();
  if (!loaded || typeof google === "undefined") return null;
  return (
    <Marker
      position={{ lat: m.lat, lng: m.lon }}
      title={m.label}
      icon={pinIcon(m.kind)}
      label={m.badge ? { text: m.badge, color: "#fff", fontWeight: "700", fontSize: "11px" } : undefined}
      zIndex={m.kind === "vehicle" ? 1000 : undefined}
      onClick={onClick}
    />
  );
}

/** Fit to markers/routes, or center on a given point. Re-runs only when the content actually changes. */
function FitTo({ markers, routes, center, zoom, fitKey }: Pick<MapProps, "markers" | "routes" | "center" | "zoom" | "fitKey">) {
  const map = useMap();
  const auto = useMemo(() => JSON.stringify([center, markers?.map((m) => [m.lat, m.lon]), routes?.map((r) => r.length)]), [center, markers, routes]);
  const key = fitKey ?? auto;
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
// Estimated road paths for data gaps, cached per endpoint pair (Routes API calls are billed).
const gapRouteCache = new globalThis.Map<string, google.maps.LatLngLiteral[] | null>();
const MAX_GAP_ROUTES = 25;

async function estimatedRoad(a: [number, number], b: [number, number]): Promise<google.maps.LatLngLiteral[] | null> {
  const key = `${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;
  if (gapRouteCache.has(key)) return gapRouteCache.get(key)!;
  let path: google.maps.LatLngLiteral[] | null = null;
  try {
    const { Route } = (await google.maps.importLibrary("routes")) as google.maps.RoutesLibrary;
    const res = await Route.computeRoutes({ origin: { lat: a[0], lng: a[1] }, destination: { lat: b[0], lng: b[1] }, travelMode: "DRIVING", fields: ["path"] });
    const pts = res.routes?.[0]?.path;
    path = pts?.length ? pts.map((x) => ({ lat: x.lat, lng: x.lng })) : null;
  } catch {
    path = null; // Routes API unavailable: fall back to a straight dotted connector
  }
  gapRouteCache.set(key, path);
  return path;
}

function Routes({ routes, gapLines }: { routes?: [number, number][][]; gapLines?: [number, number][][] }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    const lines: google.maps.Polyline[] = [];
    for (const r of routes ?? []) {
      if (r.length < 2) continue;
      const path = r.map(([lat, lng]) => ({ lat, lng }));
      // White casing under a bold blue line with direction arrows: readable on map and satellite.
      lines.push(new google.maps.Polyline({ map, path, strokeColor: "#ffffff", strokeOpacity: 0.95, strokeWeight: 9, zIndex: 1, clickable: false }));
      lines.push(
        new google.maps.Polyline({
          map,
          path,
          strokeColor: "#1a73e8",
          strokeOpacity: 1,
          strokeWeight: 5,
          zIndex: 2,
          clickable: false,
          icons: [{ icon: { path: google.maps.SymbolPath.FORWARD_OPEN_ARROW, scale: 2.4, strokeColor: "#ffffff", strokeWeight: 2 }, offset: "50px", repeat: "110px" }],
        }),
      );
    }
    let cancelled = false;
    const dotted = (path: google.maps.LatLngLiteral[], estimated: boolean) =>
      new google.maps.Polyline({
        map,
        path,
        strokeOpacity: 0,
        zIndex: 1,
        clickable: false,
        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: estimated ? 0.75 : 0.85, strokeColor: estimated ? "#9ca3af" : "#6b7280", scale: 3 }, offset: "0", repeat: estimated ? "12px" : "14px" }],
      });
    (gapLines ?? []).forEach((gl, i) => {
      const a = gl[0]!;
      const b = gl[gl.length - 1]!;
      const straight = gl.map(([lat, lng]) => ({ lat, lng }));
      if (i >= MAX_GAP_ROUTES || distanceMeters({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) <= 150) {
        lines.push(dotted(straight, false));
        return;
      }
      // Show the straight connector until the estimated road arrives, then swap it.
      const placeholder = dotted(straight, false);
      lines.push(placeholder);
      estimatedRoad(a, b).then((road) => {
        if (cancelled || !road) return;
        placeholder.setMap(null);
        lines.push(dotted(road, true));
      });
    });
    return () => {
      cancelled = true;
      lines.forEach((l) => l.setMap(null));
    };
  }, [map, routes, gapLines]);
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
  // Places API (New) text search: finds villages, landmarks and addresses; biased to the current map view.
  const places = useMapsLibrary("places");
  const map = useMap();
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
    if (!places || dq.trim().length < 3) return;
    let cancelled = false;
    setBusy(true);
    const bounds = map?.getBounds();
    places.Place.searchByText({
      textQuery: dq.trim(),
      fields: ["displayName", "formattedAddress", "location"],
      region: "in",
      maxResultCount: 6,
      ...(bounds ? { locationBias: bounds } : {}),
    })
      .then(({ places: found }) => {
        if (cancelled) return;
        const rows = found
          .filter((x) => x.location)
          .map((x, i) => ({
            id: `p${i}`,
            label: x.displayName ?? x.formattedAddress ?? "Place",
            sub: `${x.formattedAddress ?? ""} — approximate until you confirm the pin`,
            lat: x.location!.lat(),
            lon: x.location!.lng(),
          }));
        setRemote(rows);
        if (!rows.length) setMsg("No places found. Try the village or taluka name.");
      })
      .catch(() => !cancelled && setMsg("Place search is unavailable right now (check Places API on the Google key)."))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [dq, places, map]);

  const results = [...local, ...remote];
  return (
    <div className="map-search">
      <input type="search" placeholder="Search village, place or farmer" aria-label="Search place or farmer on map" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      {open && q.trim().length >= 2 ? (
        <ul className="map-results" role="listbox">
          {busy ? <li className="muted">Searching…</li> : null}
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

export function GoogleMapView({ markers = [], routes, center, zoom, height = 360, onPick, localSearch, searchable = true, title = "Map", legend, fitKey, gapLines }: MapProps) {
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
          <FitTo markers={markers} routes={routes} center={center} zoom={zoom} fitKey={fitKey} />
          <Recenter to={searchPin} />
          <Routes routes={routes} gapLines={gapLines} />
          <AccuracyCircles markers={all} />
          {all.map((m) => (
            <PinMarker key={m.id} m={m} onClick={() => setOpenInfo(m.id)} />
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

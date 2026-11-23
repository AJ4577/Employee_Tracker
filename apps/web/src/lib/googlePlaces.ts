// Address -> map position with Google Places (browser key, referrer-restricted).
const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

type W = Window & { google?: { maps?: { importLibrary?: (name: string) => Promise<unknown> } } };

/** Load the Maps JS API on demand (Google's dynamic-import bootstrap). Safe alongside the map component. */
export function ensureGoogleMaps(): boolean {
  const w = window as W;
  if (w.google?.maps?.importLibrary) return true;
  if (!KEY) return false;
  const params = new URLSearchParams({ key: KEY, v: "weekly", region: "IN", language: "en", loading: "async" });
  const libs = new Set<string>();
  let loading: Promise<void> | null = null;
  const g = (w.google ??= {} as NonNullable<W["google"]>);
  const maps = (g.maps ??= {} as NonNullable<NonNullable<W["google"]>["maps"]>) as Record<string, unknown>;
  const load = () =>
    (loading ??= new Promise<void>((resolve, reject) => {
      params.set("libraries", [...libs].join(","));
      params.set("callback", "google.maps.__kr_cb");
      maps.__kr_cb = () => resolve();
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?${params}`;
      s.async = true;
      s.onerror = () => reject(new Error("Google Maps could not load"));
      document.head.append(s);
    }));
  const boot = (name: string) => {
    libs.add(name);
    return load().then(() => (maps.importLibrary as (n: string) => Promise<unknown>)(name));
  };
  maps.importLibrary = boot;
  return true;
}

const PLUS_CODE = /\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/i;

export interface AddressParts {
  address?: string | null;
  village?: string | null;
  district?: string | null;
  state?: string | null;
  postcode?: string | null;
}

export interface GeoHit {
  lat: number;
  lon: number;
  label: string;
  source: "google_pluscode" | "google_address";
}

/**
 * Find the farm on the map from its address. A plus code in the address (e.g. "HPQR+65W") is the
 * most precise, so it is tried first with the locality; otherwise the full address text.
 */
export async function geocodeFarmerAddress(a: AddressParts): Promise<GeoHit | null> {
  if (!ensureGoogleMaps()) return null;
  const full = [a.address, a.village, a.district, a.state, a.postcode].filter(Boolean).join(", ");
  if (!full.trim()) return null;
  const { Place } = (await (window as W).google!.maps!.importLibrary!("places")) as google.maps.PlacesLibrary;
  const tries: { q: string; source: GeoHit["source"] }[] = [];
  const plus = full.match(PLUS_CODE)?.[0];
  if (plus) tries.push({ q: [plus, a.village, a.district, a.state].filter(Boolean).join(", "), source: "google_pluscode" });
  tries.push({ q: full, source: "google_address" });
  // Accept a result only if it lies in the farmer's PIN code (or district when no PIN is given):
  // vague addresses can otherwise match a same-named village in another state.
  const pin = (a.postcode ?? "").replace(/\s/g, "");
  const district = (a.district ?? "").trim().toLowerCase();
  const plausible = (addr: string) => {
    const t = addr.toLowerCase().replace(/\s/g, "");
    if (pin) return t.includes(pin);
    if (district) return t.includes(district.replace(/\s/g, ""));
    return true;
  };
  for (const t of tries) {
    try {
      const { places } = await Place.searchByText({ textQuery: t.q, fields: ["displayName", "formattedAddress", "location"], region: "in", maxResultCount: 5 });
      const p = places.find((x) => x.location && plausible(x.formattedAddress ?? ""));
      if (p?.location) return { lat: p.location.lat(), lon: p.location.lng(), label: p.displayName ?? p.formattedAddress ?? t.q, source: t.source };
    } catch {
      /* try the next query */
    }
  }
  return null;
}

// POST /functions/v1/places  { q: string }  or  { lat, lon }  (reverse)
// Authenticated geocoding proxy. Provider is configured by the operator — never a hard-coded
// public demo server. Only the search text / coordinates leave the system (no farmer profile).
//   GEOCODER_SEARCH_URL   e.g. https://us1.locationiq.com/v1/search?format=json&countrycodes=in&limit=6&q={q}&key={key}
//   GEOCODER_REVERSE_URL  e.g. https://us1.locationiq.com/v1/reverse?format=json&lat={lat}&lon={lon}&key={key}
//   GEOCODER_KEY          provider key (server-side secret)
//   GEOCODER_NAME         label stored as geocode_source, e.g. "locationiq"
// Expected response: Nominatim-compatible JSON (array of { lat, lon, display_name, importance? }).
import { getCaller, HttpError, rateLimit, readJson, serve, serviceClient } from "../_shared/http.ts";

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  const { caller } = await getCaller(req);
  const body = await readJson<{ q?: string; lat?: number; lon?: number }>(req);
  const searchTpl = Deno.env.get("GEOCODER_SEARCH_URL");
  const reverseTpl = Deno.env.get("GEOCODER_REVERSE_URL");
  const key = Deno.env.get("GEOCODER_KEY") ?? "";
  const provider = Deno.env.get("GEOCODER_NAME") ?? "geocoder";

  let url: string;
  let cacheKey: string;
  if (typeof body.q === "string") {
    const q = body.q.trim();
    if (q.length < 3 || q.length > 200) throw new HttpError(400, "validation", "Search text must be 3–200 characters");
    if (!searchTpl) throw new HttpError(503, "provider_not_configured");
    url = searchTpl.replace("{q}", encodeURIComponent(q)).replace("{key}", encodeURIComponent(key));
    cacheKey = `s:${provider}:${q.toLowerCase()}`;
  } else if (typeof body.lat === "number" && typeof body.lon === "number" && Math.abs(body.lat) <= 90 && Math.abs(body.lon) <= 180) {
    if (!reverseTpl) throw new HttpError(503, "provider_not_configured");
    url = reverseTpl.replace("{lat}", body.lat.toFixed(6)).replace("{lon}", body.lon.toFixed(6)).replace("{key}", encodeURIComponent(key));
    cacheKey = `r:${provider}:${body.lat.toFixed(5)},${body.lon.toFixed(5)}`;
  } else {
    throw new HttpError(400, "validation", "Provide q or lat/lon");
  }

  const svc = serviceClient();
  const hash = await sha256(cacheKey);
  const { data: cached } = await svc.from("geocode_cache").select("results, created_at").eq("query_hash", hash).maybeSingle();
  const maxAgeDays = Number(Deno.env.get("GEOCODER_CACHE_DAYS") ?? "30");
  if (cached && Date.now() - Date.parse(cached.created_at) < maxAgeDays * 86400e3) {
    return { provider, cached: true, results: cached.results };
  }

  await rateLimit(svc, `geo:${caller.id}`, 60, 3600);
  await rateLimit(svc, `geo-org:${caller.organization_id}`, 2000, 86400);

  const res = await fetch(url, { headers: { "user-agent": "KisanRoute/1.0 (field-ops geocoding)", accept: "application/json" } });
  if (res.status === 429) throw new HttpError(429, "rate_limited");
  if (!res.ok) throw new HttpError(502, "provider_error", `Geocoder returned ${res.status}`);
  const raw = await res.json();
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const results = arr.slice(0, 8).map((r: Record<string, unknown>) => ({
    lat: Number(r.lat),
    lon: Number(r.lon),
    label: String(r.display_name ?? r.name ?? ""),
    confidence: typeof r.importance === "number" ? Math.min(1, Math.max(0, r.importance)) : null,
    approximate: true,
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));

  await svc.from("geocode_cache").upsert({ query_hash: hash, provider, results, created_at: new Date().toISOString() });
  return { provider, cached: false, results };
});

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatInTz, freshness, timeAgo, utcToLocalInput, zonedToUtc, type FeedItem, type RoutePoint, type StaffBoardRow, type StaffRoute, type TrackPoint } from "@kisanroute/shared";
import { must, rpc } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { useNow } from "../../lib/hooks";
import { useStaffList } from "../../lib/data";
import { Section } from "../../ui/Layout";
import { Button, Empty, ErrorState, FreshnessBadge, KV, Loading, PageHeader, Select, TextInput } from "../../ui/ui";
import { staffMarkerKind, type MapMarker } from "../../map/MapView";
import { RouteHistory } from "./RouteHistory";

/** Split accepted points into segments at gaps > 5 minutes (never join across gaps). */
export function segmentRoute(points: RoutePoint[], gapS = 300): [number, number][][] {
  const segs: [number, number][][] = [];
  let cur: [number, number][] = [];
  let prev: RoutePoint | null = null;
  for (const p of points) {
    if (prev && (Date.parse(p[3]) - Date.parse(prev[3])) / 1000 > gapS) {
      if (cur.length) segs.push(cur);
      cur = [];
    }
    cur.push([p[0], p[1]]);
    prev = p;
  }
  if (cur.length) segs.push(cur);
  return segs;
}

export default function Tracking() {
  const { tz, settings } = useAuth();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const staffId = params.get("staff") ?? "";
  const visitId = params.get("visit") ?? "";
  const date = params.get("date") ?? utcToLocalInput(new Date().toISOString(), tz).slice(0, 10);
  const [tripId, setTripId] = useState("");
  const staff = useStaffList(true);
  const board = useQuery({ queryKey: ["staff-board"], queryFn: () => rpc<StaffBoardRow[]>("admin_staff_board"), refetchInterval: 30_000 });
  const [from, to] = useMemo(() => {
    const s = zonedToUtc(`${date}T00:00`, tz);
    return [s.toISOString(), new Date(s.getTime() + 86400e3).toISOString()];
  }, [date, tz]);
  const route = useQuery({
    queryKey: ["route", staffId, from],
    queryFn: () => rpc<StaffRoute>("staff_route", { p_staff: staffId, p_from: from, p_to: to, p_trip: null }),
    enabled: !!staffId,
    refetchInterval: 60_000,
  });
  const feed = useQuery({
    queryKey: ["feed-staff", staffId, from],
    queryFn: () => rpc<FeedItem[]>("admin_activity_feed", { p_from: from, p_to: to, p_staff: staffId, p_limit: 500 }),
    enabled: !!staffId,
    refetchInterval: 60_000,
  });
  const visitIds = useMemo(
    () => [...new Set([...(feed.data ?? []).map((e) => e.visit_id), ...(route.data?.trips ?? []).map((t) => t.visit_id), ...(visitId ? [visitId] : [])])],
    [feed.data, route.data, visitId],
  );
  const dayVisits = useQuery({
    queryKey: ["day-visits", visitIds.join(",")],
    queryFn: async () =>
      (
        await must<{ id: string; target_lat: number | null; target_lon: number | null; farmer: { name: string } | null }[]>(
          supabase.from("visits").select("id,target_lat,target_lon,farmer:farmers(name)").in("id", visitIds),
        )
      ).map((v) => ({ id: v.id, target_lat: v.target_lat, target_lon: v.target_lon, farmer_name: v.farmer?.name ?? "Farmer" })),
    enabled: visitIds.length > 0,
  });

  const me = board.data?.find((r) => r.id === staffId);
  const f = me && me.lat !== null ? freshness(me.received_at, !!me.duty_id && me.duty_mode === "tracking", settings.stale_after_s, now) : "unavailable";

  // Narrow to one trip, or to both legs of one visit (opened from the visit page's "Play route").
  const trips = route.data?.trips ?? [];
  const tripFilter = useMemo(() => {
    if (tripId) return new Set([tripId]);
    if (visitId) return new Set(trips.filter((t) => t.visit_id === visitId).map((t) => t.id));
    return null;
  }, [tripId, visitId, trips]);
  const rawPoints = useMemo(() => {
    const seen = new Set<string>();
    return (route.data?.points ?? []).filter((p) => {
      if (tripFilter && !(p[4] !== null && tripFilter.has(p[4]))) return false;
      const k = `${p[3]}|${p[0].toFixed(6)}|${p[1].toFixed(6)}`; // same fix sent twice (e.g. two tabs)
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [route.data, tripFilter]);
  const trackPoints: TrackPoint[] = useMemo(() => rawPoints.map((p) => ({ lat: p[0], lon: p[1], accuracy_m: p[2], t: Date.parse(p[3]), trip_id: p[4] })), [rawPoints]);
  const segments = useMemo(() => segmentRoute(rawPoints), [rawPoints]);
  const events = useMemo(() => (feed.data ?? []).filter((e) => !visitId || e.visit_id === visitId), [feed.data, visitId]);
  const visitsForMap = useMemo(() => (dayVisits.data ?? []).filter((v) => !visitId || v.id === visitId), [dayVisits.data, visitId]);
  const liveMarker: MapMarker | null =
    me && me.lat !== null && !visitId && !tripId
      ? { id: "latest", lat: me.lat, lon: me.lon!, label: `${me.display_name} — ${f === "live" ? "Live" : `Last known at ${formatInTz(me.device_time, tz)}`}`, kind: staffMarkerKind(f), accuracy_m: me.accuracy_m }
      : null;
  const visitName = visitId ? visitsForMap[0]?.farmer_name : null;

  return (
    <>
      <PageHeader title="Live tracking & route history" sub="Where the staff member went, when, and how long they stayed — from GPS points actually recorded during duty." />
      <div className="filters">
        <Select label="Staff member" value={staffId} onChange={(e) => { setTripId(""); setParams({ staff: e.target.value, date }); }}>
          <option value="">Choose staff…</option>
          {staff.data?.filter((s) => s.role === "staff").map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </Select>
        <TextInput label="Date" type="date" value={date} onChange={(e) => { setTripId(""); setParams({ staff: staffId, date: e.target.value }); }} />
        {trips.length && !visitId ? (
          <Select label="Trip" value={tripId} onChange={(e) => setTripId(e.target.value)}>
            <option value="">Whole day</option>
            {trips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.leg === "outbound" ? "To" : "Return from"} {t.farmer_name} · {formatInTz(t.started_at, tz, { day: undefined, month: undefined })}
              </option>
            ))}
          </Select>
        ) : null}
        {visitId ? (
          <div className="field">
            <span className="small">Showing the visit{visitName ? ` to ${visitName}` : ""} (both legs)</span>
            <Button variant="secondary" className="btn-sm" onClick={() => setParams({ staff: staffId, date })}>Show whole day</Button>
          </div>
        ) : null}
      </div>
      {!staffId ? (
        <Empty title="Choose a staff member to see their location and route" />
      ) : (
        <>
          <Section>
            {route.isLoading ? (
              <Loading />
            ) : route.error ? (
              <ErrorState error={route.error} onRetry={() => route.refetch()} />
            ) : (
              <RouteHistory
                points={trackPoints}
                visits={visitsForMap}
                events={events}
                tz={tz}
                fitKey={`${staffId}|${date}|${tripId}|${visitId}|${trackPoints.length > 0}`}
                liveMarker={liveMarker}
                segments={segments}
                tripModes={Object.fromEntries(trips.map((tr) => [tr.id, tr.travel_mode ?? null]))}
              />
            )}
            {route.data?.flagged_count ? <p className="small muted">{route.data.flagged_count} implausible or drifted point(s) were hidden.</p> : null}
          </Section>
          <Section title={me?.display_name ?? "Staff"}>
            {me ? (
              <>
                <p>
                  <FreshnessBadge f={f} />
                </p>
                <KV
                  items={[
                    ["Duty", me.duty_id ? `${me.duty_mode === "limited" ? "On duty — location sharing off" : "On duty"} since ${formatInTz(me.duty_started_at, tz)}` : "Off duty"],
                    ["Last fix (device time)", me.device_time ? formatInTz(me.device_time, tz, { second: "2-digit" }) : "None"],
                    ["Last server sync", me.received_at ? `${formatInTz(me.received_at, tz, { second: "2-digit" })} (${timeAgo(me.received_at, now)})` : "Never"],
                    ["Accuracy", me.accuracy_m !== null ? `±${Math.round(me.accuracy_m)} m${me.quality === "low_accuracy" ? " (low)" : ""}` : "—"],
                    ["Current trip", me.active_farmer ? `${me.active_leg === "return" ? "Returning from" : "Heading to"} ${me.active_farmer}` : "None"],
                    ["Points shown", String(trackPoints.length)],
                  ]}
                />
                {me.active_visit_id ? <Link to={`/admin/visits/${me.active_visit_id}`}>Open current visit →</Link> : null}
              </>
            ) : (
              <Loading />
            )}
            {route.data?.duty.length ? (
              <>
                <h3 className="h3">Duty periods</h3>
                <ul className="small">
                  {route.data.duty.map((d, i) => (
                    <li key={i}>
                      {formatInTz(d.started_at, tz)} → {d.ended_at ? formatInTz(d.ended_at, tz) : "ongoing"} ({d.mode === "limited" ? "location off" : "location on"})
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Section>
        </>
      )}
    </>
  );
}

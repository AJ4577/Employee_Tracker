import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatInTz, freshness, timeAgo, utcToLocalInput, zonedToUtc, type RoutePoint, type StaffBoardRow, type StaffRoute } from "@kisanroute/shared";
import { rpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useNow } from "../../lib/hooks";
import { useStaffList } from "../../lib/data";
import { Section } from "../../ui/Layout";
import { Banner, Empty, ErrorState, FreshnessBadge, KV, Loading, PageHeader, Select, TextInput } from "../../ui/ui";
import { MapView, staffMarkerKind, type MapMarker } from "../../map/MapView";

/** Split accepted points into segments at trip changes and gaps > 5 minutes (never join across gaps). */
export function segmentRoute(points: RoutePoint[], gapS = 300): [number, number][][] {
  const segs: [number, number][][] = [];
  let cur: [number, number][] = [];
  let prev: RoutePoint | null = null;
  for (const p of points) {
    if (prev && (p[4] !== prev[4] || (Date.parse(p[3]) - Date.parse(prev[3])) / 1000 > gapS)) {
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
  const date = params.get("date") ?? utcToLocalInput(new Date().toISOString(), tz).slice(0, 10);
  const [tripId, setTripId] = useState("");
  const staff = useStaffList(true);
  const board = useQuery({ queryKey: ["staff-board"], queryFn: () => rpc<StaffBoardRow[]>("admin_staff_board"), refetchInterval: 30_000 });
  const [from, to] = useMemo(() => {
    const s = zonedToUtc(`${date}T00:00`, tz);
    return [s.toISOString(), new Date(s.getTime() + 86400e3).toISOString()];
  }, [date, tz]);
  const route = useQuery({
    queryKey: ["route", staffId, from, tripId],
    queryFn: () => rpc<StaffRoute>("staff_route", { p_staff: staffId, p_from: from, p_to: to, p_trip: tripId || null }),
    enabled: !!staffId,
    refetchInterval: 60_000,
  });
  const me = board.data?.find((r) => r.id === staffId);
  const f = me && me.lat !== null ? freshness(me.received_at, !!me.duty_id && me.duty_mode === "tracking", settings.stale_after_s, now) : "unavailable";
  const segments = useMemo(() => segmentRoute(route.data?.points ?? []), [route.data]);
  const markers: MapMarker[] = [];
  if (me && me.lat !== null)
    markers.push({ id: "latest", lat: me.lat, lon: me.lon!, label: `${me.display_name} — ${f === "live" ? "Live" : `Last known at ${formatInTz(me.device_time, tz)}`}`, kind: staffMarkerKind(f), accuracy_m: me.accuracy_m });
  const pts = route.data?.points ?? [];
  if (pts.length) {
    const first = pts[0]!;
    markers.push({ id: "start", lat: first[0], lon: first[1], label: `First point ${formatInTz(first[3], tz)}`, kind: "pick" });
  }

  return (
    <>
      <PageHeader title="Live tracking" sub="Actual GPS points recorded by the staff app during duty. Lines are drawn only between real consecutive points." />
      <div className="filters">
        <Select label="Staff member" value={staffId} onChange={(e) => { setTripId(""); setParams({ staff: e.target.value, date }); }}>
          <option value="">Choose staff…</option>
          {staff.data?.filter((s) => s.role === "staff").map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </Select>
        <TextInput label="Date" type="date" value={date} onChange={(e) => { setTripId(""); setParams({ staff: staffId, date: e.target.value }); }} />
        {route.data?.trips.length ? (
          <Select label="Trip" value={tripId} onChange={(e) => setTripId(e.target.value)}>
            <option value="">All trips that day</option>
            {route.data.trips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.leg === "outbound" ? "To" : "Return from"} {t.farmer_name} · {formatInTz(t.started_at, tz, { day: undefined, month: undefined })}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {!staffId ? <Empty title="Choose a staff member to see their location and route" /> : (
        <div className="grid-2 wide-left">
          <Section>
            {route.isLoading ? <Loading /> : route.error ? <ErrorState error={route.error} onRetry={() => route.refetch()} /> : null}
            <MapView
              markers={markers}
              routes={segments}
              height={480}
              title="Staff route map"
              legend={<span className="small">Green line = recorded GPS trail (accepted points only). Gaps &gt; 5 min are left unconnected. {route.data?.flagged_count ? `${route.data.flagged_count} implausible/drifted point(s) hidden.` : ""}</span>}
            />
            {route.data && !pts.length ? <Banner kind="info">No GPS points recorded for this day{tripId ? " and trip" : ""}. The staff member may have used limited mode, denied location permission, or been offline.</Banner> : null}
          </Section>
          <Section title={me?.display_name ?? "Staff"}>
            {me ? (
              <>
                <p><FreshnessBadge f={f} /></p>
                <KV
                  items={[
                    ["Duty", me.duty_id ? `${me.duty_mode === "limited" ? "On duty — location sharing off" : "On duty"} since ${formatInTz(me.duty_started_at, tz)}` : "Off duty"],
                    ["Last fix (device time)", me.device_time ? formatInTz(me.device_time, tz, { second: "2-digit" }) : "None"],
                    ["Last server sync", me.received_at ? `${formatInTz(me.received_at, tz, { second: "2-digit" })} (${timeAgo(me.received_at, now)})` : "Never"],
                    ["Accuracy", me.accuracy_m !== null ? `±${Math.round(me.accuracy_m)} m${me.quality === "low_accuracy" ? " (low)" : ""}` : "—"],
                    ["Current trip", me.active_farmer ? `${me.active_leg === "return" ? "Returning from" : "Heading to"} ${me.active_farmer}` : "None"],
                    ["Points this day", String(pts.length)],
                  ]}
                />
                {me.active_visit_id ? <Link to={`/admin/visits/${me.active_visit_id}`}>Open current visit →</Link> : null}
              </>
            ) : <Loading />}
            {route.data?.duty.length ? (
              <>
                <h3 className="h3">Duty periods</h3>
                <ul className="small">
                  {route.data.duty.map((d, i) => (
                    <li key={i}>{formatInTz(d.started_at, tz)} → {d.ended_at ? formatInTz(d.ended_at, tz) : "ongoing"} ({d.mode})</li>
                  ))}
                </ul>
              </>
            ) : null}
          </Section>
        </div>
      )}
    </>
  );
}

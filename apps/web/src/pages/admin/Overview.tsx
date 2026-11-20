import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { dayRangeInTz, EVENT_LABEL, formatDistance, formatInTz, freshness, timeAgo, type FeedItem, type Overview as OverviewT, type StaffBoardRow } from "@kisanroute/shared";
import { supabase } from "../../lib/supabase";
import { rpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useNow } from "../../lib/hooks";
import { useStaffList } from "../../lib/data";
import { Section } from "../../ui/Layout";
import { Empty, ErrorState, FreshnessBadge, Loading, PageHeader, Select, Stat } from "../../ui/ui";
import { MapView, staffMarkerKind, type MapMarker } from "../../map/MapView";

export default function Overview() {
  const { tz, settings } = useAuth();
  const now = useNow();
  const qc = useQueryClient();
  const [staffFilter, setStaffFilter] = useState("");
  const [from, to] = useMemo(() => dayRangeInTz(tz), [tz]);
  const staff = useStaffList();

  const overview = useQuery({ queryKey: ["overview", from], queryFn: () => rpc<OverviewT>("admin_overview", { p_from: from, p_to: to }), refetchInterval: 60_000 });
  const board = useQuery({ queryKey: ["staff-board"], queryFn: () => rpc<StaffBoardRow[]>("admin_staff_board"), refetchInterval: 30_000 });
  const feed = useQuery({
    queryKey: ["feed", from, staffFilter],
    queryFn: () => rpc<FeedItem[]>("admin_activity_feed", { p_from: from, p_to: to, p_staff: staffFilter || null, p_limit: 100 }),
    refetchInterval: 30_000,
  });

  // Realtime: only while this page is open; RLS limits rows to this organization.
  useEffect(() => {
    const ch = supabase
      .channel("admin-overview")
      .on("postgres_changes", { event: "*", schema: "public", table: "latest_staff_position" }, () => qc.invalidateQueries({ queryKey: ["staff-board"] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "visits" }, () => {
        qc.invalidateQueries({ queryKey: ["overview"] });
        qc.invalidateQueries({ queryKey: ["feed"] });
        qc.invalidateQueries({ queryKey: ["staff-board"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const rows = (board.data ?? []).filter((r) => !staffFilter || r.id === staffFilter);
  const markers: MapMarker[] = rows
    .filter((r) => r.lat !== null && r.lon !== null)
    .map((r) => {
      const f = freshness(r.received_at, !!r.duty_id && r.duty_mode === "tracking", settings.stale_after_s, now);
      return {
        id: r.id,
        lat: r.lat!,
        lon: r.lon!,
        label: r.display_name,
        kind: staffMarkerKind(f),
        accuracy_m: r.accuracy_m,
        popup: (
          <div>
            <strong>{r.display_name}</strong>
            <br />
            {f === "live" ? "Live" : f === "stale" ? "Stale" : "Last known"} · {formatInTz(r.device_time, tz)} ({timeAgo(r.received_at, now)})
            <br />±{Math.round(r.accuracy_m ?? 0)} m{r.active_farmer ? ` · ${r.active_leg === "return" ? "Returning from" : "Heading to"} ${r.active_farmer}` : ""}
          </div>
        ),
      };
    });

  const o = overview.data;
  return (
    <>
      <PageHeader title="Overview" sub={`Today in ${tz} · server data`} actions={<Link className="btn btn-primary" to="/admin/visits?new=1">+ Assign visit</Link>} />
      {overview.error ? <ErrorState error={overview.error} onRetry={() => overview.refetch()} /> : null}
      <div className="stats">
        <Stat label="Active products" value={o?.active_products ?? "…"} />
        <Stat label="Active farmers" value={o?.active_farmers ?? "…"} />
        <Stat label="Active staff" value={o ? `${o.active_staff} (${o.on_duty} on duty)` : "…"} />
        <Stat label="Visits today" value={o?.visits_in_range ?? "…"} />
        <Stat label="In progress / arrived" value={o?.in_progress_now ?? "…"} />
        <Stat label="Completed today" value={o?.by_status.completed ?? (o ? 0 : "…")} tone="ok" />
        <Stat label="Overdue" value={o?.overdue ?? "…"} tone={o && o.overdue > 0 ? "danger" : undefined} />
        <Stat label="Flagged arrivals today" value={o?.flagged_arrivals ?? "…"} tone={o && o.flagged_arrivals > 0 ? "warn" : undefined} />
      </div>

      <div className="grid-2">
        <Section
          title="Staff positions"
          actions={
            <Select label="Staff" value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)}>
              <option value="">All staff</option>
              {staff.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </Select>
          }
        >
          <MapView
            markers={markers}
            height={380}
            title="Staff positions map"
            localSearch={(q) => rows.filter((r) => r.lat !== null && r.display_name.toLowerCase().includes(q.toLowerCase())).map((r) => ({ id: r.id, label: r.display_name, sub: "Staff", lat: r.lat!, lon: r.lon! }))}
            legend={
              <span className="small">
                <span className="pin-inline pin-staff-live" /> Live (on duty, &lt; {Math.round(settings.stale_after_s / 60)} min) <span className="pin-inline pin-staff-stale" /> Stale <span className="pin-inline pin-staff-last" /> Last known (off duty)
              </span>
            }
          />
          {board.isLoading ? <Loading /> : board.error ? <ErrorState error={board.error} onRetry={() => board.refetch()} /> : (
            <ul className="list compact">
              {rows.map((r) => {
                const f = r.lat === null ? "unavailable" : freshness(r.received_at, !!r.duty_id && r.duty_mode === "tracking", settings.stale_after_s, now);
                return (
                  <li key={r.id} className="list-item">
                    <div>
                      <Link to={`/admin/tracking?staff=${r.id}`}>
                        <strong>{r.display_name}</strong>
                      </Link>
                      <div className="small muted">
                        {r.duty_id ? (r.duty_mode === "limited" ? "On duty (location sharing off)" : "On duty") : "Off duty"} · {r.open_visits} open
                        {r.overdue_visits ? <span className="text-danger"> · {r.overdue_visits} overdue</span> : null}
                        {r.active_farmer ? ` · ${r.active_leg === "return" ? "returning from" : "→"} ${r.active_farmer}` : ""}
                      </div>
                      <div className="small muted">
                        {r.received_at ? `Last update ${timeAgo(r.received_at, now)}, ±${Math.round(r.accuracy_m ?? 0)} m` : "No location received"}
                      </div>
                    </div>
                    <FreshnessBadge f={f} />
                  </li>
                );
              })}
              {!rows.length ? <Empty title="No staff yet">Invite staff from the Staff page.</Empty> : null}
            </ul>
          )}
        </Section>

        <Section title="Today's activity">
          {feed.isLoading ? <Loading /> : feed.error ? <ErrorState error={feed.error} onRetry={() => feed.refetch()} /> : !feed.data?.length ? <Empty title="No activity recorded today yet" /> : (
            <ol className="timeline">
              {feed.data.map((e) => (
                <li key={e.id} className={e.flagged ? "flagged" : ""}>
                  <time>{formatInTz(e.occurred_at, tz, { day: undefined, month: undefined })}</time>
                  <div>
                    <Link to={`/admin/visits/${e.visit_id}`}>
                      <strong>{EVENT_LABEL[e.event_type] ?? e.event_type}</strong> · {e.farmer_name}
                    </Link>
                    <div className="small muted">
                      {e.actor_name ?? "System"}
                      {e.village ? ` · ${e.village}` : ""}
                      {e.distance_m !== null ? ` · ${formatDistance(e.distance_m)} from pin` : ""}
                      {e.flagged ? " · ⚑ needs review" : ""}
                      {e.reason ? ` · “${e.reason}”` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </>
  );
}

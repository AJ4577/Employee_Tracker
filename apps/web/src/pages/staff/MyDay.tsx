import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { dayRangeInTz, formatInTz, TASK_TYPE_LABEL, type MyVisitListItem } from "@kisanroute/shared";
import { rpc, ApiError } from "../../lib/api";
import { getBrowserFix } from "../../lib/hooks";
import { useWebTracking } from "../../lib/webTracking";
import { useAuth } from "../../lib/auth";
import { useToast } from "../../ui/toast";
import { Section } from "../../ui/Layout";
import { Banner, Button, Empty, ErrorState, Loading, PageHeader, StatusBadge } from "../../ui/ui";

export function DutyCard() {
  const { me, tz, settings, refreshMe } = useAuth();
  const track = useWebTracking();
  const toast = useToast();
  // Ask for location first; share live location only if the browser grants it.
  const start = useMutation({
    mutationFn: async () => {
      const fix = await getBrowserFix();
      await rpc("start_duty", { p_mode: fix ? "tracking" : "limited" });
      return !!fix;
    },
    onSuccess: (shared) => {
      refreshMe();
      toast(shared ? "ok" : "info", shared ? "Duty started. Live location is on while this page stays open." : "Duty started without live location (permission denied or no GPS).");
    },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const setMode = useMutation({
    mutationFn: async (mode: "tracking" | "limited") => {
      if (mode === "tracking" && !(await getBrowserFix())) throw new ApiError({ code: "validation", message: "Location permission is blocked or GPS is off. Allow location for this site and try again." });
      await rpc("start_duty", { p_mode: mode });
    },
    onSuccess: () => refreshMe(),
    onError: (e: ApiError) => toast("error", e.message),
  });
  const end = useMutation({
    mutationFn: () => rpc("end_duty"),
    onSuccess: () => { refreshMe(); toast("ok", "Duty ended. Location sharing stopped."); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const d = me?.duty;
  const poor = track.accuracyM !== null && track.accuracyM > settings.low_accuracy_m;
  return (
    <Section title="Duty">
      {d ? (
        <>
          <p>
            <span className={`badge ${d.mode === "tracking" ? "fresh-live" : "fresh-stale"}`}><span className="dot" aria-hidden />{d.mode === "tracking" ? "On duty · live location on" : "On duty · live location off"}</span>
          </p>
          <p className="small muted">Since {formatInTz(d.started_at, tz)}</p>
          {d.mode === "tracking" ? (
            <>
              <Banner kind="info">Keep this page open with the screen on. Location stops if you close the browser, lock the phone or switch apps.</Banner>
              <p className="small">
                {track.state === "denied" ? <span className="text-danger">Location permission is blocked for this site. Allow it in the browser settings.</span>
                  : track.lastFixAt ? <>Last location {formatInTz(track.lastFixAt, tz, { second: "2-digit" })}{track.accuracyM !== null ? ` · accuracy ±${Math.round(track.accuracyM)} m` : ""}{track.lastSyncAt ? ` · sent ${formatInTz(track.lastSyncAt, tz, { day: undefined, month: undefined, second: "2-digit" })}` : ""}{track.pending ? ` · ${track.pending} waiting to send` : ""}</>
                  : "Waiting for your location…"}
              </p>
              {poor ? <Banner kind="warn">Your location is approximate (±{Math.round(track.accuracyM!)} m). Use a phone with Location ON and “Precise / High accuracy” enabled — laptops guess location from Wi‑Fi and can be kilometres off.</Banner> : null}
              <div className="row">
                <Button variant="secondary" onClick={() => setMode.mutate("limited")} busy={setMode.isPending}>Stop sharing location</Button>
                <Button variant="secondary" onClick={() => end.mutate()} busy={end.isPending}>End duty</Button>
              </div>
            </>
          ) : (
            <>
              <p className="small muted">Your admin can't see your live position.</p>
              <div className="row">
                <Button onClick={() => setMode.mutate("tracking")} busy={setMode.isPending}>Share live location</Button>
                <Button variant="secondary" onClick={() => end.mutate()} busy={end.isPending}>End duty</Button>
              </div>
            </>
          )}
          {me?.active_trip ? <Banner kind="info">Trip in progress ({me.active_trip.leg}). Finish it from the visit page.</Banner> : null}
        </>
      ) : (
        <>
          <p>You're off duty. No location is collected.</p>
          <Banner kind="info">Starting duty shares your live location with your admin while this page is open. It stops when you end duty. For tracking with the phone locked, use the KisanRoute Staff mobile app.</Banner>
          <Button onClick={() => start.mutate()} busy={start.isPending}>Start duty</Button>
        </>
      )}
    </Section>
  );
}

export function VisitCard({ v, tz }: { v: MyVisitListItem; tz: string }) {
  return (
    <li className="visit-card">
      <Link to={`/staff/visits/${v.id}`} className="visit-card-link">
        <div className="row-between">
          <strong>{v.farmer_name}</strong>
          <StatusBadge status={v.status} />
        </div>
        <div className="small muted">
          {formatInTz(v.scheduled_at, v.timezone ?? tz)} · {TASK_TYPE_LABEL[v.type]}
          {v.village ? ` · ${v.village}` : ""}
          {v.priority === "high" || v.priority === "urgent" ? <span className={`prio prio-${v.priority}`}> {v.priority}</span> : null}
        </div>
        {v.target_lat === null ? <div className="small text-warn">No map pin — ask admin</div> : !v.location_verified ? <div className="small text-warn">Approximate location</div> : null}
      </Link>
    </li>
  );
}

export default function MyDay() {
  const { me, tz } = useAuth();
  const [from, to] = useMemo(() => dayRangeInTz(tz), [tz]);
  const q = useQuery({ queryKey: ["my-visits", "today", from], queryFn: () => rpc<MyVisitListItem[]>("my_visits", { p_from: from, p_to: to, p_scope: "all" }), refetchInterval: 60_000 });
  const overdue = useQuery({ queryKey: ["my-visits", "overdue"], queryFn: () => rpc<MyVisitListItem[]>("my_visits", { p_from: null, p_to: from, p_scope: "open" }) });
  return (
    <>
      <PageHeader title={`Namaste, ${me?.profile.display_name.split(" ")[0] ?? ""}`} sub={formatInTz(new Date().toISOString(), tz, { weekday: "long", hour: undefined, minute: undefined })} />
      <DutyCard />
      {overdue.data?.length ? (
        <Section title={`Overdue (${overdue.data.length})`}>
          <ul className="visit-list">{overdue.data.map((v) => <VisitCard key={v.id} v={v} tz={tz} />)}</ul>
        </Section>
      ) : null}
      <Section title="Today's visits">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <Empty title="No visits scheduled for today" /> : (
          <ul className="visit-list">{q.data.map((v) => <VisitCard key={v.id} v={v} tz={tz} />)}</ul>
        )}
      </Section>
    </>
  );
}

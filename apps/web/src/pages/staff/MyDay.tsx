import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { dayRangeInTz, formatInTz, TASK_TYPE_LABEL, type MyVisitListItem } from "@kisanroute/shared";
import { rpc, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useToast } from "../../ui/toast";
import { Section } from "../../ui/Layout";
import { Banner, Button, Empty, ErrorState, Loading, PageHeader, StatusBadge } from "../../ui/ui";

export function DutyCard() {
  const { me, tz, refreshMe } = useAuth();
  const toast = useToast();
  const start = useMutation({
    mutationFn: () => rpc("start_duty", { p_mode: "limited" }),
    onSuccess: () => { refreshMe(); toast("ok", "Duty started (browser mode)."); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const end = useMutation({
    mutationFn: () => rpc("end_duty"),
    onSuccess: () => { refreshMe(); toast("ok", "Duty ended."); },
    onError: (e: ApiError) => toast("error", e.message),
  });
  const d = me?.duty;
  return (
    <Section title="Duty">
      {d ? (
        <>
          <p>
            <span className={`badge ${d.mode === "tracking" ? "fresh-live" : "fresh-stale"}`}><span className="dot" aria-hidden />{d.mode === "tracking" ? "On duty · tracking on (mobile app)" : "On duty · location only at actions"}</span>
          </p>
          <p className="small muted">Since {formatInTz(d.started_at, tz)}</p>
          {me?.active_trip ? <Banner kind="info">Trip in progress ({me.active_trip.leg}). Finish it from the visit page.</Banner> : null}
          <Button variant="secondary" onClick={() => end.mutate()} busy={end.isPending}>End duty</Button>
        </>
      ) : (
        <>
          <p>You're off duty. No location is collected.</p>
          <Banner kind="info">For continuous trip tracking (phone locked / app closed), use the KisanRoute Staff mobile app. In the browser, your location is captured only when you tap Start trip or Mark arrived.</Banner>
          <Button onClick={() => start.mutate()} busy={start.isPending}>Start duty (browser)</Button>
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

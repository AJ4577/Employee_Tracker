import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatInTz, utcToLocalInput, zonedToUtc, type StaffRoute } from "@kisanroute/shared";
import { rpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { ROLE_LABEL, Section } from "../../ui/Layout";
import { Empty, KV, Loading, PageHeader, TextInput } from "../../ui/ui";
import { MapView } from "../../map/MapView";
import { segmentRoute } from "../admin/Tracking";

export default function Profile() {
  const { me, tz, settings } = useAuth();
  const [date, setDate] = useState(utcToLocalInput(new Date().toISOString(), tz).slice(0, 10));
  const [from, to] = useMemo(() => {
    const s = zonedToUtc(`${date}T00:00`, tz);
    return [s.toISOString(), new Date(s.getTime() + 86400e3).toISOString()];
  }, [date, tz]);
  const route = useQuery({ queryKey: ["my-route", from], queryFn: () => rpc<StaffRoute>("staff_route", { p_staff: me!.profile.id, p_from: from, p_to: to }), enabled: me?.profile.role === "staff" });
  const p = me?.profile;
  return (
    <>
      <PageHeader title="My profile" />
      <Section>
        <KV
          items={[
            ["Name", p?.display_name],
            ["Role", p ? <span key="r" className={`badge role-${p.role}`}>{ROLE_LABEL[p.role]}</span> : "—"],
            ["Email", p?.email],
            ["Phone", p?.phone],
            ...(p?.role === "staff" ? ([["Coverage area", p?.coverage_area]] as [string, ReactNode][]) : []),
            ["Organization", settings.organization_name],
            ["Member since", p ? formatInTz(p.created_at, tz, { hour: undefined, minute: undefined }) : "—"],
          ]}
        />
        {p && p.role !== "staff" ? (
          <p className="small muted">
            {p.role === "owner" ? "As owner you can approve admins and staff, change every setting and manage roles." : "As admin you can manage farmers, products, visits and staff, and approve staff registrations."}
          </p>
        ) : null}
      </Section>
      {p?.role === "staff" ? <Section title="Your location data">
        <ul className="small">
          <li>Location is collected only between <strong>Start duty</strong> and <strong>End duty</strong>, with a visible indicator in the app.</li>
          <li>Only administrators of {settings.organization_name || "your organization"} can see your routes. Other staff cannot.</li>
          <li>Detailed GPS points are deleted after {settings.route_retention_days} days. Visit timestamps are kept for reporting.</li>
          <li>If location isn't working, you can still complete visits — add a reason when asked.</li>
        </ul>
        <div className="filters"><TextInput label="My route on" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        {route.isLoading ? <Loading /> : !route.data?.points.length ? <Empty title="No GPS points recorded that day" /> : (
          <>
            <MapView height={300} routes={segmentRoute(route.data.points)} title="My route" searchable={false} />
            <p className="small muted">{route.data.points.length} points · duty: {route.data.duty.map((d) => `${formatInTz(d.started_at, tz)}–${d.ended_at ? formatInTz(d.ended_at, tz, { day: undefined, month: undefined }) : "now"}`).join(", ")}</p>
          </>
        )}
      </Section> : null}
    </>
  );
}

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  canTransition,
  EVENT_LABEL,
  formatDistance,
  formatDuration,
  formatInTz,
  maskPhone,
  reasonInput,
  TASK_TYPE_LABEL,
  utcToLocalInput,
  zonedToUtc,
  type AdminVisitDetail,
} from "@kisanroute/shared";
import { rpc, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useStaffList } from "../../lib/data";
import { supabase } from "../../lib/supabase";
import { useToast } from "../../ui/toast";
import { Section } from "../../ui/Layout";
import { Banner, Button, ErrorState, KV, Loading, Modal, PageHeader, Select, StatusBadge, TextArea, TextInput } from "../../ui/ui";
import { MapView } from "../../map/MapView";

export default function VisitDetailAdmin() {
  const { id } = useParams();
  const { tz } = useAuth();
  const q = useQuery({ queryKey: ["admin-visit", id], queryFn: () => rpc<AdminVisitDetail>("admin_visit_detail", { p_visit: id }) });
  const [action, setAction] = useState<null | "reassign" | "cancel" | "reschedule">(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const v = d.visit;
  const outbound = d.trips.find((t) => t.leg === "outbound" && t.status !== "abandoned");
  const ret = d.trips.find((t) => t.leg === "return" && t.status !== "abandoned");
  const arrivedEv = [...d.events].reverse().find((e) => e.event_type === "arrived");
  const open = !["completed", "cancelled"].includes(v.status);

  return (
    <>
      <PageHeader
        title={`${TASK_TYPE_LABEL[v.type]} · ${d.farmer.name}`}
        sub={<><StatusBadge status={v.status} /> Assigned to {d.staff.display_name} · v{v.version}</>}
        actions={
          open ? (
            <>
              <Button variant="secondary" onClick={() => setAction("reassign")}>Reassign</Button>
              {canTransition(v.status, "rescheduled") ? <Button variant="secondary" onClick={() => setAction("reschedule")}>Reschedule</Button> : null}
              <Button variant="danger" onClick={() => setAction("cancel")}>Cancel</Button>
            </>
          ) : null
        }
      />
      <div className="grid-2">
        <Section title="Journey timestamps">
          <KV
            items={[
              ["Scheduled", formatInTz(v.scheduled_at, v.timezone)],
              ["Due", v.due_at ? formatInTz(v.due_at, v.timezone) : "—"],
              ["Left for visit (kab gaya)", formatInTz(v.started_at, tz)],
              ["Arrived (kab pahuncha)", formatInTz(v.arrived_at, tz)],
              ["Travel time", formatDuration(v.started_at, v.arrived_at)],
              ["Arrival check", arrivedEv ? arrivalText(arrivedEv) : "Not recorded"],
              ["Meeting done (kab meeting done)", formatInTz(v.completed_at, tz)],
              ["Meeting duration", formatDuration(v.arrived_at, v.completed_at)],
              ["Return started", formatInTz(ret?.started_at, tz)],
              ["Returned (kab wapas aya)", formatInTz(ret?.ended_at, tz)],
            ]}
          />
          {arrivedEv?.reason ? <Banner kind="warn">Override reason: “{arrivedEv.reason}”</Banner> : null}
          {outbound || ret ? (
            <p className="small">
              <Link to={`/admin/tracking?staff=${v.staff_id}&date=${utcToLocalInput(v.started_at ?? v.scheduled_at, tz).slice(0, 10)}`}>View actual GPS route for this day →</Link>
            </p>
          ) : null}
        </Section>
        <Section title="Farmer & destination">
          <KV
            items={[
              ["Farmer", <Link key="f" to={`/admin/farmers/${d.farmer.id}`}>{d.farmer.name}</Link>],
              ["Phone", maskPhone(d.farmer.normalized_phone)],
              ["Village", d.farmer.village],
              ["Address", d.farmer.address],
              ["Pin", v.target_lat === null ? "No pin set" : d.farmer.location_verified ? "Confirmed" : "Approximate (not confirmed)"],
            ]}
          />
          {v.target_lat !== null ? (
            <MapView height={240} searchable={false} center={[v.target_lat, v.target_lon!]} markers={[{ id: "f", lat: v.target_lat, lon: v.target_lon!, label: d.farmer.name, kind: d.farmer.location_verified ? "farmer" : "farmer-approx" }]} />
          ) : null}
        </Section>
      </div>
      <div className="grid-2">
        <Section title="Instructions & products">
          <p className="prewrap">{v.instructions || <span className="muted">No instructions.</span>}</p>
          {d.products.length ? <p>Products: {d.products.map((p) => p.name).join(", ")}</p> : null}
          {v.status_reason ? <Banner kind="info">Last change reason: {v.status_reason}</Banner> : null}
        </Section>
        <Section title="Outcome">
          {d.outcome ? (
            <KV
              items={[
                ["Outcome", <span key="o" className="prewrap">{d.outcome.outcome_text}</span>],
                ["Next action", d.outcome.next_action],
                ["Next follow-up", d.outcome.next_followup_at ? formatInTz(d.outcome.next_followup_at, tz) : "—"],
                ["Delivery acknowledged", d.outcome.delivery_confirmation === null ? "—" : d.outcome.delivery_confirmation ? "Yes" : "No"],
                ["Recorded (server)", formatInTz(d.outcome.recorded_at, tz)],
              ]}
            />
          ) : (
            <p className="muted">Not completed yet.</p>
          )}
          <Attachments items={d.attachments} />
        </Section>
      </div>
      <Section title="Event history (append-only)">
        <ol className="timeline">
          {d.events.map((e, i) => (
            <li key={e.id ?? i} className={e.flagged ? "flagged" : ""}>
              <time>{formatInTz(e.occurred_at, tz)}</time>
              <div>
                <strong>{EVENT_LABEL[e.event_type] ?? e.event_type}</strong> · {e.actor_name ?? "System"}
                <div className="small muted">
                  Server received {formatInTz(e.received_at, tz, { second: "2-digit" })} · source {e.source}
                  {e.accuracy_m !== null && e.accuracy_m !== undefined ? ` · ±${Math.round(e.accuracy_m)} m` : ""}
                  {e.reason ? ` · “${e.reason}”` : ""}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Section>
      <ActionModal action={action} onClose={() => setAction(null)} detail={d} />
    </>
  );
}

function arrivalText(e: AdminVisitDetail["events"][number]): string {
  const g = (e.metadata as { geofence?: string } | undefined)?.geofence;
  const acc = e.accuracy_m ? ` (GPS ±${Math.round(e.accuracy_m)} m)` : "";
  const what =
    g === "no_target_pin" ? `farm had no pin, distance not checked${acc}`
    : g === "no_device_fix" ? "no GPS fix from the phone"
    : g === "low_accuracy" ? `GPS too weak to confirm${e.distance_m !== null ? `, ~${formatDistance(e.distance_m)} from pin` : ""}${acc}`
    : e.distance_m !== null ? `${formatDistance(e.distance_m)} from pin${acc}`
    : `not checked${acc}`;
  return `${what}${e.flagged ? " · ⚑ manual override" : " · within radius"}`;
}

function Attachments({ items }: { items: AdminVisitDetail["attachments"] }) {
  const toast = useToast();
  if (!items.length) return null;
  const open = async (path: string) => {
    const { data, error } = await supabase.storage.from("visit-proof").createSignedUrl(path, 60);
    if (error || !data) return toast("error", "Could not open file.");
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };
  return (
    <div>
      <h3 className="h3">Proof</h3>
      <ul className="list compact">
        {items.map((a) => (
          <li key={a.id} className="list-item">
            <span>{a.kind} · {a.mime_type}</span>
            <Button variant="secondary" className="btn-sm" onClick={() => open(a.storage_path)}>Open (1-min link)</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionModal({ action, onClose, detail }: { action: null | "reassign" | "cancel" | "reschedule"; onClose: () => void; detail: AdminVisitDetail }) {
  const { tz } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const staff = useStaffList();
  const [reason, setReason] = useState("");
  const [newStaff, setNewStaff] = useState("");
  const [when, setWhen] = useState(utcToLocalInput(detail.visit.scheduled_at, tz));
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const r = reasonInput.safeParse(reason);
      if (!r.success) throw new ApiError({ code: "validation", message: r.error.issues[0]!.message });
      const v = detail.visit;
      if (action === "reassign") {
        if (!newStaff) throw new ApiError({ code: "validation", message: "Choose a staff member." });
        return rpc("admin_reassign_visit", { p_visit: v.id, p_new_staff: newStaff, p_reason: r.data, p_version: v.version });
      }
      if (action === "cancel") return rpc("admin_cancel_visit", { p_visit: v.id, p_reason: r.data, p_version: v.version });
      return rpc("admin_reschedule_visit", { p_visit: v.id, p_scheduled_at: zonedToUtc(when, tz).toISOString(), p_reason: r.data, p_version: v.version });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-visit", detail.visit.id] });
      qc.invalidateQueries({ queryKey: ["visits"] });
      toast("ok", action === "reassign" ? "Reassigned. Previous staff lost access; new staff notified." : action === "cancel" ? "Visit cancelled. Staff notified." : "Rescheduled. Staff notified.");
      setReason("");
      onClose();
    },
    onError: (e: ApiError) => setErr(e.message),
  });
  if (!action) return null;
  return (
    <Modal
      title={action === "reassign" ? "Reassign visit" : action === "cancel" ? "Cancel visit" : "Reschedule visit"}
      open
      onClose={onClose}
      footer={<Button variant={action === "cancel" ? "danger" : "primary"} busy={m.isPending} onClick={() => m.mutate()}>Confirm</Button>}
    >
      {err ? <Banner kind="error">{err}</Banner> : null}
      {action === "reassign" ? (
        <Select label="New staff member" required value={newStaff} onChange={(e) => setNewStaff(e.target.value)}>
          <option value="">Choose…</option>
          {staff.data?.filter((s) => s.id !== detail.visit.staff_id).map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </Select>
      ) : null}
      {action === "reschedule" ? <TextInput label={`New time (${tz})`} type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} /> : null}
      <TextArea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the visit history and audit log." />
    </Modal>
  );
}

import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EVENT_LABEL,
  fieldErrors,
  formatDistance,
  formatInTz,
  googleDirectionsToAddressUrl,
  googleDirectionsUrl,
  outcomeInput,
  TASK_TYPE_LABEL,
  zonedToUtc,
  type MyVisitDetail,
} from "@kisanroute/shared";
import { rpc, ApiError, newIdempotencyKey } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { getBrowserFix, useOnline, type DeviceFix } from "../../lib/hooks";
import { useToast } from "../../ui/toast";
import { Section } from "../../ui/Layout";
import { Banner, Button, ErrorState, KV, Loading, Modal, PageHeader, StatusBadge, TextArea, TextInput } from "../../ui/ui";
import { MapView } from "../../map/MapView";

type Action = "start" | "arrive" | "return" | "end_return";

export default function StaffVisit() {
  const { id } = useParams();
  const { tz, me, refreshMe, settings } = useAuth();
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const [pending, setPending] = useState<{ action: Action; key: string; fix: DeviceFix | null; detail?: Record<string, unknown> } | null>(null);
  const [reason, setReason] = useState("");
  const [completing, setCompleting] = useState(false);
  const q = useQuery({ queryKey: ["my-visit", id], queryFn: () => rpc<MyVisitDetail>("my_visit_detail", { p_visit: id }) });

  const run = useMutation({
    mutationFn: async ({ action, key, fix, overrideReason }: { action: Action; key: string; fix: DeviceFix | null; overrideReason?: string }) => {
      const geo = { p_lat: fix?.lat ?? null, p_lon: fix?.lon ?? null, p_accuracy_m: fix?.accuracy_m ?? null, p_device_time: fix?.device_time ?? new Date().toISOString() };
      if (action === "start") return rpc("staff_start_visit", { p_visit: id, p_idempotency_key: key, ...geo });
      if (action === "arrive") return rpc("staff_arrive_visit", { p_visit: id, p_idempotency_key: key, ...geo, p_override_reason: overrideReason ?? null });
      if (action === "return") return rpc("staff_start_return", { p_visit: id, p_idempotency_key: key, ...geo });
      const trip = q.data!.trips.find((t) => t.leg === "return" && t.status === "active");
      return rpc("staff_end_trip", { p_trip: trip!.id, p_idempotency_key: key, ...geo });
    },
    onSuccess: (_r, vars) => {
      setPending(null);
      setReason("");
      qc.invalidateQueries({ queryKey: ["my-visit", id] });
      qc.invalidateQueries({ queryKey: ["my-visits"] });
      refreshMe();
      toast("ok", vars.action === "start" ? "Trip started." : vars.action === "arrive" ? "Arrival recorded." : vars.action === "return" ? "Return trip started." : "Return recorded.");
    },
    onError: (e: ApiError, vars) => {
      if (e.code === "reason_required") setPending({ action: vars.action, key: vars.key, fix: vars.fix, detail: e.detail ?? undefined });
      else toast("error", e.message);
    },
  });

  const act = async (action: Action) => {
    const fix = await getBrowserFix();
    if (action === "start" && !me?.duty) {
      try {
        // Share live location during the trip when the browser gives us a position.
        await rpc("start_duty", { p_mode: fix ? "tracking" : "limited" });
        await refreshMe();
      } catch (e) {
        return toast("error", (e as Error).message);
      }
    }
    if (!fix && action === "arrive") toast("info", "Location unavailable — you'll be asked for a reason.");
    run.mutate({ action, key: newIdempotencyKey(), fix });
  };

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const v = d.visit;
  const f = d.farmer;
  const pin = v.target_lat !== null ? { lat: v.target_lat, lon: v.target_lon! } : null;
  const returnTrip = d.trips.find((t) => t.leg === "return" && t.status !== "abandoned");
  const busy = run.isPending;
  const addr = [f.address, f.village, f.district, f.state, f.postcode].filter(Boolean).join(", ");

  return (
    <>
      <PageHeader title={f.name} sub={<><StatusBadge status={v.status} /> {TASK_TYPE_LABEL[v.type]} · {formatInTz(v.scheduled_at, v.timezone)}</>} />
      {!online ? <Banner kind="warn">Offline — actions will fail until you reconnect. Use the mobile app for offline work.</Banner> : null}

      <div className="action-bar">
        {f.phone ? <a className="btn btn-secondary" href={`tel:${f.phone}`}>📞 Call</a> : null}
        {pin ? (
          <a className="btn btn-secondary" href={googleDirectionsUrl(pin)} target="_blank" rel="noopener noreferrer">🧭 Get directions</a>
        ) : addr ? (
          <a className="btn btn-secondary" href={googleDirectionsToAddressUrl(addr)} target="_blank" rel="noopener noreferrer" title="No farm pin yet — Google will route to its best match for the address">🧭 Directions (by address)</a>
        ) : null}
        {["assigned", "rescheduled"].includes(v.status) ? <Button onClick={() => act("start")} busy={busy}>Start trip</Button> : null}
        {v.status === "in_progress" ? <Button onClick={() => act("arrive")} busy={busy}>Mark arrived</Button> : null}
        {v.status === "arrived" ? <Button onClick={() => setCompleting(true)}>Complete meeting</Button> : null}
        {v.status === "completed" && !returnTrip ? <Button variant="secondary" onClick={() => act("return")} busy={busy}>Start return trip</Button> : null}
        {returnTrip?.status === "active" ? <Button onClick={() => act("end_return")} busy={busy}>I'm back (end return)</Button> : null}
      </div>

      <div className="grid-2">
        <Section title="Farm location">
          {pin ? (
            <>
              {!f.location_verified ? <Banner kind="warn">This pin is approximate (not confirmed by admin). Confirm with the farmer by phone.</Banner> : null}
              <MapView height={320} center={[pin.lat, pin.lon]} markers={[{ id: "farm", lat: pin.lat, lon: pin.lon, label: f.name, kind: f.location_verified ? "farmer" : "farmer-approx", popup: <div><strong>{f.name}</strong><br />{addr}</div> }]} title="Farm map" />
            </>
          ) : (
            <Banner kind="warn">No map pin for this farmer yet. “Directions (by address)” goes to Google's best match for the address, which may not be the exact farm — call the farmer to confirm, and ask your admin to set the pin.</Banner>
          )}
          <p className="small">{addr || "No address recorded."}</p>
        </Section>
        <Section title="Details">
          <KV items={[
            ["Phone", f.phone ? <a key="p" href={`tel:${f.phone}`}>{f.phone}</a> : "—"],
            ["Alternate", f.alt_contact],
            ["Crops", f.crops.join(", ") || "—"],
            ["Products", d.products.map((p) => p.name).join(", ") || "—"],
            ["Instructions", <span key="i" className="prewrap">{v.instructions ?? "—"}</span>],
          ]} />
          {d.recent_purchases.length ? (
            <>
              <h3 className="h3">Recent purchases</h3>
              <ul className="small">
                {d.recent_purchases.map((p, i) => <li key={i}>{formatInTz(p.purchased_at, tz, { hour: undefined, minute: undefined })}: {(p.items ?? []).map((it) => `${it.name} ${Number(it.quantity)} ${it.unit}`).join(", ")}</li>)}
              </ul>
            </>
          ) : null}
        </Section>
      </div>

      <Section title="Progress">
        <ol className="timeline">
          {d.events.map((e, i) => (
            <li key={i} className={e.flagged ? "flagged" : ""}>
              <time>{formatInTz(e.occurred_at, tz)}</time>
              <div>
                <strong>{EVENT_LABEL[e.event_type] ?? e.event_type}</strong>
                {e.distance_m !== null ? <span className="small muted"> · {formatDistance(e.distance_m)} from pin</span> : null}
                {e.reason ? <div className="small muted">“{e.reason}”</div> : null}
              </div>
            </li>
          ))}
        </ol>
        {d.outcome ? <Banner kind="ok">Outcome: {d.outcome.outcome_text}</Banner> : null}
      </Section>

      {pending ? (
        <Modal title="Reason needed" open onClose={() => setPending(null)} footer={<Button busy={busy} onClick={() => run.mutate({ action: pending.action, key: pending.key, fix: pending.fix, overrideReason: reason })} disabled={reason.trim().length < 3}>Submit</Button>}>
          <p>
            {pending.detail?.geofence === "outside"
              ? `You appear to be ${formatDistance(Number(pending.detail.distance_m))} from the farm pin (allowed ${settings.arrival_radius_m} m).`
              : pending.detail?.geofence === "low_accuracy"
                ? "Your GPS accuracy is too low to confirm arrival."
                : pending.detail?.geofence === "no_target_pin"
                  ? "This farmer has no confirmed map pin."
                  : "Your location isn't available."}{" "}
            Add a short reason. Your admin will see it.
          </p>
          <TextArea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Met farmer at village market" />
        </Modal>
      ) : null}
      {completing ? <CompleteForm d={d} onClose={() => setCompleting(false)} /> : null}
    </>
  );
}

function CompleteForm({ d, onClose }: { d: MyVisitDetail; onClose: () => void }) {
  const { tz, settings, refreshMe, me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [key] = useState(newIdempotencyKey);
  const [f, setF] = useState({ outcome_text: "", next_action: "", next_local: "", delivery_confirmation: false, products: [] as string[] });
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const options = useQuery({ queryKey: ["product-options"], queryFn: () => rpc<{ id: string; name: string }[]>("staff_product_options") });

  const m = useMutation({
    mutationFn: async () => {
      const payload = {
        outcome_text: f.outcome_text,
        products_discussed: f.products,
        next_action: f.next_action,
        next_followup_at: f.next_local ? zonedToUtc(f.next_local, tz).toISOString() : null,
        delivery_confirmation: d.visit.type === "delivery" ? f.delivery_confirmation : null,
      };
      const parsed = outcomeInput.safeParse(payload);
      if (!parsed.success) { setErrors(fieldErrors(parsed.error)); throw new ApiError({ code: "validation", message: "Please fix the highlighted fields." }); }
      setErrors({});
      if (file) {
        if (file.size > 10 * 1024 * 1024) throw new ApiError({ code: "validation", message: "Photo must be under 10 MB." });
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new ApiError({ code: "validation", message: "Use a JPG, PNG or WebP photo." });
        const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
        // Path convention enforced by storage policy + register_attachment: {org}/{visit}/{uuid}.{ext}
        const objectPath = `${me!.profile.organization_id}/${d.visit.id}/${crypto.randomUUID()}.${ext}`;
        const up = await supabase.storage.from("visit-proof").upload(objectPath, file, { contentType: file.type, upsert: false });
        if (up.error) throw new ApiError({ code: "unknown", message: `Photo upload failed: ${up.error.message}` });
        await rpc("register_attachment", { p_visit: d.visit.id, p_storage_path: objectPath, p_mime: file.type, p_size: file.size, p_kind: "photo" });
      }
      return rpc("staff_complete_visit", { p_visit: d.visit.id, p_idempotency_key: key, p_outcome: parsed.data, p_device_time: new Date().toISOString() });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-visit", d.visit.id] });
      qc.invalidateQueries({ queryKey: ["my-visits"] });
      refreshMe();
      toast("ok", "Meeting completed. Start the return trip when you leave.");
      onClose();
    },
    onError: (e: ApiError) => toast("error", e.message),
  });

  return (
    <Modal title="Complete meeting" open onClose={onClose} footer={<Button form="cf" type="submit" busy={m.isPending}>Save & complete</Button>}>
      <form id="cf" className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <TextArea label="What happened?" required value={f.outcome_text} onChange={(e) => setF({ ...f, outcome_text: e.target.value })} error={errors.outcome_text} />
        <fieldset className="checks">
          <legend>Products discussed / delivered</legend>
          {options.data?.map((p) => (
            <label key={p.id}><input type="checkbox" checked={f.products.includes(p.id)} onChange={(e) => setF({ ...f, products: e.target.checked ? [...f.products, p.id] : f.products.filter((x) => x !== p.id) })} />{p.name}</label>
          ))}
        </fieldset>
        {d.visit.type === "delivery" ? (
          <label className="check-inline"><input type="checkbox" checked={f.delivery_confirmation} onChange={(e) => setF({ ...f, delivery_confirmation: e.target.checked })} /> Farmer acknowledged delivery{settings.require_delivery_ack ? " (required)" : ""}</label>
        ) : null}
        <TextInput label="Next action" value={f.next_action} onChange={(e) => setF({ ...f, next_action: e.target.value })} />
        <TextInput label={`Next follow-up (${tz})`} type="datetime-local" value={f.next_local} onChange={(e) => setF({ ...f, next_local: e.target.value })} hint="Creates a follow-up visit assigned to you." />
        <TextInput label={`Photo proof${settings.require_photo_on_complete ? " (required)" : " (optional)"}`} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </form>
    </Modal>
  );
}

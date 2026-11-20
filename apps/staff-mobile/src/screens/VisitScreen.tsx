import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Modal, Pressable, ScrollView, Switch, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import {
  EVENT_LABEL,
  evaluateGeofence,
  formatDistance,
  formatInTz,
  googleDirectionsUrl,
  outcomeInput,
  TASK_TYPE_LABEL,
  type MyVisitDetail,
} from "@kisanroute/shared";
import { useSession } from "../session";
import { rpc, ApiError, isNetworkError } from "../api";
import { db, kvGet, kvSet } from "../db";
import { onSyncChange, performAction, type QueuedAction } from "../sync";
import { currentFix, setActiveTrip } from "../tracking";
import { supabase } from "../supabase";
import { MapWebView } from "../MapWebView";
import { Banner, Button, C, Card, Field, Muted, StatusBadge, s } from "../ui";

export function VisitScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { settings, refresh, me } = useSession();
  const [d, setD] = useState<MyVisitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [offlineCopy, setOfflineCopy] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState<{ lat: number; lon: number; accuracy_m: number } | null>(null);
  const [reasonFor, setReasonFor] = useState<{ action: QueuedAction; message: string } | null>(null);
  const [reason, setReason] = useState("");
  const [completing, setCompleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await rpc<MyVisitDetail>("my_visit_detail", { p_visit: id });
      setD(r);
      setErr(null);
      setOfflineCopy(false);
      await kvSet(`visit:${id}`, JSON.stringify(r));
    } catch (e) {
      if (isNetworkError(e)) {
        const c = await kvGet(`visit:${id}`);
        if (c) {
          setD(JSON.parse(c));
          setOfflineCopy(true);
        } else setErr("Offline and this visit hasn't been opened before.");
      } else {
        await kvSet(`visit:${id}`, null);
        setErr((e as Error).message);
      }
    }
    const rows = await (await db()).getAllAsync<{ kind: string }>("SELECT kind FROM actions WHERE visit_id = ? AND status = 'pending' ORDER BY id", [id]);
    setPending(rows.map((r) => r.kind));
  }, [id]);

  useEffect(() => {
    load();
    return onSyncChange(load);
  }, [load]);

  if (err && !d)
    return (
      <View style={{ padding: 16 }}>
        <Banner kind="error">{err}</Banner>
        <Button title="Back" variant="secondary" onPress={onBack} />
      </View>
    );
  if (!d) return <Muted style={{ padding: 16 }}>Loading…</Muted>;

  const v = d.visit;
  const f = d.farmer;
  const pin = v.target_lat !== null ? { lat: v.target_lat, lon: v.target_lon! } : null;
  const returnTrip = d.trips.find((t) => t.leg === "return" && t.status !== "abandoned");
  const addr = [f.address, f.village, f.district, f.state, f.postcode].filter(Boolean).join(", ");
  const has = (k: string) => pending.includes(k);
  const effective = has("complete") ? "completed" : has("arrive") ? "arrived" : has("start") ? "in_progress" : v.status;

  const run = async (kind: QueuedAction["kind"], extra: Partial<QueuedAction> = {}) => {
    setBusy(true);
    try {
      const g = kind === "complete" ? null : await currentFix();
      if (g) setFix(g);
      const action: QueuedAction = { kind, visit_id: v.id, idempotency_key: Crypto.randomUUID(), device_time: g?.device_time ?? new Date().toISOString(), lat: g?.lat ?? null, lon: g?.lon ?? null, accuracy_m: g?.accuracy_m ?? null, ...extra };
      if (kind === "arrive" && !action.override_reason) {
        const geo = evaluateGeofence(g, pin, settings.arrival_radius_m, settings.low_accuracy_m);
        if (geo.kind !== "inside") {
          const msg = geo.kind === "outside" ? `You're ${formatDistance(geo.distance_m)} from the farm pin (allowed ${settings.arrival_radius_m} m).` : geo.kind === "low_accuracy" ? "GPS accuracy is too low to confirm arrival." : geo.kind === "no_target_pin" ? "This farmer has no map pin." : "Your location isn't available.";
          setReasonFor({ action, message: msg });
          return;
        }
      }
      if (kind === "start" && !me?.duty) {
        const ok = await new Promise<boolean>((res) => Alert.alert("Start duty first", "Go to Today and tap Start duty so your trip can be recorded.", [{ text: "OK", onPress: () => res(false) }]));
        if (!ok) return;
      }
      const r = await performAction(action);
      const res = r.result as { trip?: { id: string } } | undefined;
      if (kind === "start" || kind === "return") await setActiveTrip(res?.trip?.id ?? null);
      if (kind === "arrive" || kind === "end_trip") await setActiveTrip(null);
      if (r.queued) Alert.alert("Saved offline", "This will sync automatically when you're back online. Your admin sees it after sync.");
      await load();
      await refresh();
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === "reason_required") {
        setReasonFor({ action: { kind, visit_id: v.id, idempotency_key: Crypto.randomUUID(), device_time: new Date().toISOString(), ...extra }, message: ae.message });
      } else Alert.alert("Couldn't save", ae.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Pressable onPress={onBack} accessibilityRole="button" style={{ paddingVertical: 8 }}><Text style={{ color: C.green, fontWeight: "700" }}>‹ Back</Text></Pressable>
      <Text style={s.h1}>{f.name}</Text>
      <View style={[s.row, { marginVertical: 6 }]}>
        <StatusBadge status={effective} />
        <Muted>{TASK_TYPE_LABEL[v.type]} · {formatInTz(v.scheduled_at, v.timezone)}</Muted>
      </View>
      {offlineCopy ? <Banner kind="warn">Offline — showing saved details.</Banner> : null}
      {pending.length ? <Banner kind="warn">Pending sync: {pending.join(", ")}. Not yet visible to your admin.</Banner> : null}

      <View style={[s.row, { marginBottom: 12 }]}>
        {f.phone ? <Button title="📞 Call" variant="secondary" onPress={() => Linking.openURL(`tel:${f.phone}`)} style={{ flex: 1 }} /> : null}
        {pin ? <Button title="🧭 Directions" variant="secondary" onPress={() => Linking.openURL(googleDirectionsUrl(pin, fix))} style={{ flex: 1 }} /> : null}
      </View>
      <View style={{ gap: 8, marginBottom: 12 }}>
        {(effective === "assigned" || effective === "rescheduled") ? <Button title="Start trip (leaving now)" onPress={() => run("start")} busy={busy} /> : null}
        {effective === "in_progress" ? <Button title="Mark arrived" onPress={() => run("arrive")} busy={busy} /> : null}
        {effective === "arrived" ? <Button title="Complete meeting" onPress={() => setCompleting(true)} busy={busy} /> : null}
        {effective === "completed" && !returnTrip && !has("return") ? <Button title="Start return trip" variant="secondary" onPress={() => run("return")} busy={busy} /> : null}
        {returnTrip?.status === "active" ? <Button title="I'm back (end return trip)" onPress={() => run("end_trip", { trip_id: returnTrip.id })} busy={busy} /> : null}
      </View>

      <Card title="Farm location">
        {pin ? (
          <>
            {!f.location_verified ? <Banner kind="warn">Approximate pin (not confirmed by admin). Confirm with the farmer.</Banner> : null}
            <MapWebView pin={{ ...pin, label: f.name, approximate: !f.location_verified }} me={fix} tileUrl={settings.map_tile_url} attribution={settings.map_tile_attribution} />
          </>
        ) : <Banner kind="warn">No map pin yet. Use the address or call the farmer.</Banner>}
        <Text selectable>{addr || "No address recorded."}</Text>
      </Card>

      <Card title="Details">
        <Text style={{ marginBottom: 6 }}>{v.instructions || "No instructions."}</Text>
        {d.products.length ? <Muted>Products: {d.products.map((p) => p.name).join(", ")}</Muted> : null}
        {f.crops.length ? <Muted>Crops: {f.crops.join(", ")}</Muted> : null}
        {d.recent_purchases.length ? (
          <View style={{ marginTop: 8 }}>
            <Text style={{ fontWeight: "700" }}>Recent purchases</Text>
            {d.recent_purchases.map((p, i) => <Muted key={i}>{formatInTz(p.purchased_at, settings.timezone, { hour: undefined, minute: undefined })}: {(p.items ?? []).map((it) => `${it.name} ${Number(it.quantity)} ${it.unit}`).join(", ")}</Muted>)}
          </View>
        ) : null}
      </Card>

      <Card title="Progress">
        {d.events.map((e, i) => (
          <View key={i} style={{ paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line }}>
            <Text style={{ fontWeight: "600" }}>{EVENT_LABEL[e.event_type] ?? e.event_type}{e.flagged ? " ⚑" : ""}</Text>
            <Muted>{formatInTz(e.occurred_at, settings.timezone)}{e.distance_m !== null ? ` · ${formatDistance(e.distance_m)} from pin` : ""}{e.reason ? ` · “${e.reason}”` : ""}</Muted>
          </View>
        ))}
        {d.outcome ? <Banner kind="ok">Outcome: {d.outcome.outcome_text}</Banner> : null}
      </Card>

      <Modal visible={!!reasonFor} transparent animationType="fade" onRequestClose={() => setReasonFor(null)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 20 }}>
          <View style={[s.card, { padding: 18 }]}>
            <Text style={s.h2}>Reason needed</Text>
            <Text style={{ marginVertical: 8 }}>{reasonFor?.message} Add a short reason; your admin will review it.</Text>
            <Field label="Reason" value={reason} onChangeText={setReason} placeholder="e.g. Met farmer at village market" multiline />
            <Button title="Submit" disabled={reason.trim().length < 3} busy={busy} onPress={() => { const a = reasonFor!.action; setReasonFor(null); run(a.kind, { ...a, override_reason: reason.trim() }); setReason(""); }} />
            <Button title="Cancel" variant="secondary" onPress={() => setReasonFor(null)} style={{ marginTop: 8 }} />
          </View>
        </View>
      </Modal>
      {completing ? <CompleteModal d={d} onClose={() => setCompleting(false)} onDone={async () => { setCompleting(false); await load(); await refresh(); }} /> : null}
    </ScrollView>
  );
}

function CompleteModal({ d, onClose, onDone }: { d: MyVisitDetail; onClose: () => void; onDone: () => void }) {
  const { settings, me } = useSession();
  const [text, setText] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [days, setDays] = useState("");
  const [ack, setAck] = useState(false);
  const [products, setProducts] = useState<string[]>([]);
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [photo, setPhoto] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => Crypto.randomUUID());

  useEffect(() => {
    rpc<{ id: string; name: string }[]>("staff_product_options").then(setOptions).catch(() => setOptions(d.products));
  }, [d.products]);

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert("Camera permission needed");
    const r = await ImagePicker.launchCameraAsync({ quality: 0.6, exif: false, mediaTypes: ["images"] });
    if (!r.canceled) setPhoto(r.assets[0] ?? null);
  };

  const submit = async () => {
    const n = Number(days);
    const outcome = {
      outcome_text: text,
      products_discussed: products,
      next_action: nextAction || null,
      next_followup_at: days && n > 0 ? new Date(Date.now() + n * 86400e3).toISOString() : null,
      delivery_confirmation: d.visit.type === "delivery" ? ack : null,
    };
    const parsed = outcomeInput.safeParse(outcome);
    if (!parsed.success) return setErr(parsed.error.issues[0]!.message);
    setBusy(true);
    setErr(null);
    try {
      if (photo) {
        const path = `${me!.profile.organization_id}/${d.visit.id}/${Crypto.randomUUID()}.jpg`;
        const bytes = await (await fetch(photo.uri)).arrayBuffer();
        if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Photo is larger than 10 MB.");
        const up = await supabase.storage.from("visit-proof").upload(path, bytes, { contentType: "image/jpeg", upsert: false });
        if (up.error) throw new Error(`Photo upload failed: ${up.error.message}`);
        await rpc("register_attachment", { p_visit: d.visit.id, p_storage_path: path, p_mime: "image/jpeg", p_size: bytes.byteLength, p_kind: "photo" });
      }
      const r = await performAction({ kind: "complete", visit_id: d.visit.id, idempotency_key: key, device_time: new Date().toISOString(), outcome: parsed.data });
      if (r.queued) Alert.alert("Saved offline", photo ? "Outcome will sync when online. The photo needs a connection — attach it again later if required." : "Outcome will sync when you're back online.");
      onDone();
    } catch (e) {
      setErr(isNetworkError(e) ? "No connection for the photo upload. Remove the photo to save offline, or try again." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>Complete meeting</Text>
        {err ? <Banner kind="error">{err}</Banner> : null}
        <Field label="What happened? *" value={text} onChangeText={setText} multiline />
        <Text style={s.label}>Products discussed / delivered</Text>
        <View style={[s.row, { marginBottom: 12 }]}>
          {options.map((p) => {
            const on = products.includes(p.id);
            return (
              <Pressable key={p.id} onPress={() => setProducts(on ? products.filter((x) => x !== p.id) : [...products, p.id])} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: on ? C.green : C.line, backgroundColor: on ? C.greenLight : "#fff" }}>
                <Text>{on ? "✓ " : ""}{p.name}</Text>
              </Pressable>
            );
          })}
        </View>
        {d.visit.type === "delivery" ? (
          <View style={[s.row, { marginBottom: 12 }]}>
            <Switch value={ack} onValueChange={setAck} accessibilityLabel="Farmer acknowledged delivery" />
            <Text>Farmer acknowledged delivery{settings.require_delivery_ack ? " (required)" : ""}</Text>
          </View>
        ) : null}
        <Field label="Next action" value={nextAction} onChangeText={setNextAction} />
        <Field label="Follow-up in how many days?" keyboardType="number-pad" value={days} onChangeText={setDays} hint="Creates a follow-up visit for you." />
        <Button title={photo ? "Retake proof photo" : `Take proof photo${settings.require_photo_on_complete ? " (required)" : ""}`} variant="secondary" onPress={takePhoto} />
        {photo ? <Muted style={{ marginTop: 4 }}>Photo attached.</Muted> : null}
        <Button title="Save & complete" onPress={submit} busy={busy} style={{ marginTop: 16 }} />
        <Button title="Cancel" variant="secondary" onPress={onClose} style={{ marginTop: 8 }} />
      </ScrollView>
    </Modal>
  );
}

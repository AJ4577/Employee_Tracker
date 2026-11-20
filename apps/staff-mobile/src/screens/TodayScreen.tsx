import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Modal, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { dayRangeInTz, formatInTz, TASK_TYPE_LABEL, timeAgo, type MyVisitListItem } from "@kisanroute/shared";
import { useSession } from "../session";
import { rpc, isNetworkError } from "../api";
import { kvGet, kvSet, pendingCounts } from "../db";
import { dismissRejected, flush, onSyncChange, performAction, rejectedActions } from "../sync";
import { isTracking, permissionState, requestPermissions, startTracking, stopTracking, type PermissionState } from "../tracking";
import { Banner, Button, C, Card, Muted, StatusBadge, s } from "../ui";

export function useSyncStatus() {
  const [counts, setCounts] = useState({ points: 0, actions: 0, rejected: 0 });
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Awaited<ReturnType<typeof rejectedActions>>>([]);
  const load = useCallback(async () => {
    setCounts(await pendingCounts());
    setLastSync(await kvGet("last_sync"));
    setRejected(await rejectedActions());
  }, []);
  useEffect(() => {
    load();
    const off = onSyncChange(load);
    const t = setInterval(load, 10_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [load]);
  return { counts, lastSync, rejected, reload: load };
}

export function DutyPanel() {
  const { me, settings, refresh } = useSession();
  const [tracking, setTracking] = useState(false);
  const [perm, setPerm] = useState<PermissionState | null>(null);
  const [edu, setEdu] = useState(false);
  const [busy, setBusy] = useState(false);
  const sync = useSyncStatus();
  const duty = me?.duty;

  useEffect(() => {
    isTracking().then(setTracking);
    permissionState().then(setPerm);
  }, [me]);

  // Keep the device in step with the server: tracking runs only during a server-side tracking duty.
  useEffect(() => {
    if (!me) return;
    (async () => {
      const on = await isTracking();
      // While duty start/end is still queued offline, the server state is stale: don't override the device.
      if ((await pendingCounts()).actions > 0) return;
      if (on && (!duty || duty.mode !== "tracking")) {
        await stopTracking();
        setTracking(false);
      }
      if (duty?.mode === "tracking" && !on && (await permissionState()) !== "denied") {
        await startTracking(settings.sample_interval_s, settings.sample_distance_m);
        setTracking(true);
      }
      await kvSet("active_trip_id", me.active_trip?.id ?? null);
    })();
  }, [me, duty, settings.sample_interval_s, settings.sample_distance_m]);

  const start = async () => {
    setEdu(false);
    setBusy(true);
    try {
      const p = await requestPermissions();
      setPerm(p);
      const mode = p === "denied" ? "limited" : "tracking";
      const r = await performAction({ kind: "start_duty", mode, idempotency_key: Crypto.randomUUID(), device_time: new Date().toISOString() });
      if (mode === "tracking") {
        await startTracking(settings.sample_interval_s, settings.sample_distance_m);
        setTracking(true);
      }
      if (p === "foreground_only") Alert.alert("Background location is off", "Your route is recorded only while KisanRoute is open. To record trips with the phone locked, allow location “All the time” in Settings.", [{ text: "Open settings", onPress: () => Linking.openSettings() }, { text: "OK" }]);
      if (p === "denied") Alert.alert("Limited mode", "Location permission was denied. You can still work on visits; arrivals will ask for a reason and your admin will see that location was unavailable.");
      if (r.queued) Alert.alert("Offline", "Duty start will sync when you're back online.");
      await refresh();
    } catch (e) {
      Alert.alert("Couldn't start duty", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    setBusy(true);
    try {
      await stopTracking();
      setTracking(false);
      await flush();
      await performAction({ kind: "end_duty", idempotency_key: Crypto.randomUUID(), device_time: new Date().toISOString() });
      await refresh();
    } catch (e) {
      Alert.alert("Couldn't end duty", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Duty">
      {duty ? (
        <>
          <View style={[s.badge, { backgroundColor: tracking ? C.greenLight : C.warnBg, marginBottom: 8 }]}>
            <Text style={{ fontWeight: "800", color: tracking ? C.greenDark : C.warn }}>{tracking ? "● ON DUTY · TRACKING ON" : duty.mode === "limited" ? "ON DUTY · LOCATION OFF (limited mode)" : "ON DUTY · TRACKING PAUSED"}</Text>
          </View>
          <Muted>Since {formatInTz(duty.started_at, settings.timezone)}</Muted>
          {perm === "foreground_only" && tracking ? <Banner kind="warn">Background location not allowed — tracking pauses when the app is closed.</Banner> : null}
          {me?.active_trip ? <Banner kind="info">{me.active_trip.leg === "return" ? "Return trip in progress." : "Trip to farmer in progress."}</Banner> : null}
          <Button title="End duty" variant="secondary" onPress={end} busy={busy} style={{ marginTop: 8 }} />
        </>
      ) : (
        <>
          <Muted>You're off duty. No location is collected.</Muted>
          <Button title="Start duty" onPress={() => setEdu(true)} busy={busy} style={{ marginTop: 10 }} />
        </>
      )}
      <View style={{ marginTop: 10 }}>
        <Muted>
          {sync.counts.actions || sync.counts.points ? `Pending sync: ${sync.counts.actions} action(s), ${sync.counts.points} location point(s). ` : "All changes synced. "}
          {sync.lastSync ? `Last location sync ${timeAgo(sync.lastSync)}.` : ""}
        </Muted>
      </View>
      {sync.rejected.map((r) => (
        <Banner key={r.id} kind="error">
          <Text style={{ color: C.danger }}>Couldn't sync “{r.kind}” from {formatInTz(r.created_at, settings.timezone)}: {r.error}</Text>
          <Pressable onPress={() => dismissRejected(r.id)} accessibilityRole="button"><Text style={{ color: C.danger, fontWeight: "700", marginTop: 6 }}>Dismiss</Text></Pressable>
        </Banner>
      ))}
      <Modal visible={edu} transparent animationType="fade" onRequestClose={() => setEdu(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 20 }}>
          <View style={[s.card, { padding: 18 }]}>
            <Text style={s.h2}>Before you start</Text>
            <Text style={{ marginVertical: 10, lineHeight: 21 }}>
              While on duty, KisanRoute records your location (about every {settings.sample_interval_s} s or {settings.sample_distance_m} m), including when the phone is locked. A notification shows while tracking is on.{"\n\n"}
              Only your organization's admins can see it. Tracking stops when you tap End duty. Detailed points are deleted after {settings.route_retention_days} days.{"\n\n"}
              Next, your phone will ask for location permission. Choose “Allow all the time” for trip recording.
            </Text>
            <Button title="Continue" onPress={start} />
            <Button title="Cancel" variant="secondary" onPress={() => setEdu(false)} style={{ marginTop: 8 }} />
          </View>
        </View>
      </Modal>
    </Card>
  );
}

export function VisitRow({ v, tz, onOpen }: { v: MyVisitListItem; tz: string; onOpen: (id: string) => void }) {
  return (
    <Pressable onPress={() => onOpen(v.id)} accessibilityRole="button" style={({ pressed }) => [s.card, { padding: 12 }, pressed && { backgroundColor: C.greenLight }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={[s.h2, { flex: 1 }]} numberOfLines={2}>{v.farmer_name}</Text>
        <StatusBadge status={v.status} />
      </View>
      <Muted>{formatInTz(v.scheduled_at, v.timezone ?? tz)} · {TASK_TYPE_LABEL[v.type]}{v.village ? ` · ${v.village}` : ""}</Muted>
      {v.target_lat === null ? <Text style={{ color: C.warn, marginTop: 4 }}>No map pin</Text> : !v.location_verified ? <Text style={{ color: C.warn, marginTop: 4 }}>Approximate location</Text> : null}
    </Pressable>
  );
}

export function VisitList({ scope, onOpen, header }: { scope: "today" | "open" | "history"; onOpen: (id: string) => void; header?: React.ReactNode }) {
  const { settings, me } = useSession();
  const [rows, setRows] = useState<MyVisitListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const key = `list:${scope}`;
    try {
      const [from, to] = dayRangeInTz(settings.timezone);
      const args = scope === "today" ? { p_from: from, p_to: to, p_scope: "all" } : scope === "open" ? { p_from: null, p_to: null, p_scope: "open" } : { p_from: new Date(Date.now() - 90 * 86400e3).toISOString(), p_to: null, p_scope: "history" };
      const r = await rpc<MyVisitListItem[]>("my_visits", args);
      const list = scope === "history" ? [...r].reverse() : r;
      setRows(list);
      setErr(null);
      await kvSet(key, JSON.stringify(list));
    } catch (e) {
      const cached = await kvGet(key);
      if (cached) setRows(JSON.parse(cached));
      setErr(isNetworkError(e) ? "Offline — showing last saved list." : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [scope, settings.timezone]);
  useEffect(() => {
    load();
  }, [load, me?.unread_notifications]);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      {header}
      {err ? <Banner kind="warn">{err}</Banner> : null}
      <Text style={[s.h2, { marginBottom: 8 }]}>{scope === "today" ? "Today's visits" : scope === "open" ? "Open visits" : "Past 90 days"}</Text>
      {rows === null ? <Muted>Loading…</Muted> : rows.length === 0 ? <Muted>No visits.</Muted> : rows.map((v) => <VisitRow key={v.id} v={v} tz={settings.timezone} onOpen={onOpen} />)}
    </ScrollView>
  );
}

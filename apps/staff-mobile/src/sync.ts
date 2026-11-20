import NetInfo from "@react-native-community/netinfo";
import { LOCATION_BATCH_MAX } from "@kisanroute/shared";
import { db, kvSet } from "./db";
import { rpc, ApiError, isNetworkError } from "./api";
import { supabase } from "./supabase";

export type ActionKind = "start" | "arrive" | "complete" | "return" | "end_trip" | "start_duty" | "end_duty";

export interface QueuedAction {
  kind: ActionKind;
  visit_id?: string | null;
  trip_id?: string | null;
  idempotency_key: string;
  lat?: number | null;
  lon?: number | null;
  accuracy_m?: number | null;
  device_time: string;
  override_reason?: string | null;
  outcome?: Record<string, unknown>;
  mode?: "tracking" | "limited";
}

type Listener = () => void;
const listeners = new Set<Listener>();
export const onSyncChange = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const emit = () => listeners.forEach((l) => l());

/** Send one action to the server. Throws ApiError. Same idempotency key on every retry. */
export async function sendAction(a: QueuedAction): Promise<unknown> {
  const geo = { p_lat: a.lat ?? null, p_lon: a.lon ?? null, p_accuracy_m: a.accuracy_m ?? null, p_device_time: a.device_time };
  switch (a.kind) {
    case "start_duty":
      return rpc("start_duty", { p_mode: a.mode ?? "tracking" });
    case "end_duty":
      return rpc("end_duty");
    case "start":
      return rpc("staff_start_visit", { p_visit: a.visit_id, p_idempotency_key: a.idempotency_key, ...geo });
    case "arrive":
      return rpc("staff_arrive_visit", { p_visit: a.visit_id, p_idempotency_key: a.idempotency_key, ...geo, p_override_reason: a.override_reason ?? null });
    case "complete":
      return rpc("staff_complete_visit", { p_visit: a.visit_id, p_idempotency_key: a.idempotency_key, p_outcome: a.outcome ?? {}, p_device_time: a.device_time });
    case "return":
      return rpc("staff_start_return", { p_visit: a.visit_id, p_idempotency_key: a.idempotency_key, ...geo });
    case "end_trip":
      return rpc("staff_end_trip", { p_trip: a.trip_id, p_idempotency_key: a.idempotency_key, ...geo });
  }
}

/**
 * Try the action now; if the device is offline, queue it and return { queued: true }.
 * Server-side rejections (validation, invalid transition, reason_required) are thrown to the
 * caller so the user can fix them immediately.
 */
export async function performAction(a: QueuedAction): Promise<{ queued: boolean; result?: unknown }> {
  // Keep order: if older actions are still queued, this one must wait behind them.
  const d = await db();
  const ahead = await d.getFirstAsync<{ n: number }>("SELECT COUNT(*) n FROM actions WHERE status = 'pending'");
  if (!ahead?.n) {
    try {
      return { queued: false, result: await sendAction(a) };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  await d.runAsync("INSERT INTO actions (kind, visit_id, payload, created_at) VALUES (?, ?, ?, ?)", [a.kind, a.visit_id ?? null, JSON.stringify(a), new Date().toISOString()]);
  emit();
  return { queued: true };
}

let running = false;

/** Flush queued actions (in order) then location points (batched). Safe to call often. */
export async function flush(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const net = await NetInfo.fetch();
    if (net.isConnected === false) return;
    const { data } = await supabase.auth.getSession(); // refreshes an expired access token
    if (!data.session) return;
    const d = await db();

    const actions = await d.getAllAsync<{ id: number; payload: string; attempts: number }>(
      "SELECT id, payload, attempts FROM actions WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT 50",
      [Date.now()],
    );
    for (const row of actions) {
      const a = JSON.parse(row.payload) as QueuedAction;
      try {
        await sendAction(a);
        await d.runAsync("DELETE FROM actions WHERE id = ?", [row.id]);
      } catch (e) {
        if (isNetworkError(e)) {
          const wait = Math.min(15 * 60_000, 5_000 * 2 ** row.attempts);
          await d.runAsync("UPDATE actions SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?", [Date.now() + wait, row.id]);
          break; // preserve order
        }
        // Server rejected (e.g. visit reassigned, reason needed). Keep for the user to review.
        await d.runAsync("UPDATE actions SET status = 'rejected', error = ? WHERE id = ?", [(e as ApiError).message, row.id]);
      }
    }
    emit();

    // Location points, grouped by trip, oldest first.
    for (let guard = 0; guard < 20; guard++) {
      const pts = await d.getAllAsync<{ client_event_id: string; sequence: number; trip_id: string | null; device_time: string; lat: number; lon: number; accuracy_m: number; speed_ms: number | null }>(
        "SELECT * FROM points ORDER BY sequence LIMIT ?",
        [LOCATION_BATCH_MAX],
      );
      if (!pts.length) break;
      const trip = pts[0]!.trip_id;
      const batch = pts.filter((p) => p.trip_id === trip);
      try {
        const res = await rpc<{ accepted: { client_event_id: string }[]; rejected: { client_event_id: string; reason: string }[]; server_time: string }>("ingest_location_batch", {
          p_points: batch.map(({ trip_id: _t, ...p }) => p),
          p_trip: trip,
        });
        const done = [...res.accepted, ...res.rejected].map((x) => x.client_event_id);
        if (done.length) await d.runAsync(`DELETE FROM points WHERE client_event_id IN (${done.map(() => "?").join(",")})`, done);
        await kvSet("last_sync", res.server_time);
        if (done.length < batch.length) break;
      } catch (e) {
        const code = (e as ApiError).code;
        if (code === "duty_not_started" || code === "tracking_disabled" || code === "forbidden") {
          // Server says we're not on a tracking duty (ended elsewhere / suspended): discard and stop.
          await d.runAsync("DELETE FROM points");
          const { stopTracking } = await import("./tracking");
          await stopTracking();
        } else if (code === "not_found") {
          // Trip no longer ours (reassigned): keep the points but detach them from that trip.
          await d.runAsync("UPDATE points SET trip_id = NULL WHERE trip_id IS ?", [trip]);
          continue;
        }
        break;
      }
    }
    emit();
  } finally {
    running = false;
  }
}

let started = false;
export function startSyncLoop(): void {
  if (started) return;
  started = true;
  NetInfo.addEventListener((s) => {
    if (s.isConnected) flush().catch(() => {});
  });
  setInterval(() => flush().catch(() => {}), 30_000);
}

export async function rejectedActions(): Promise<{ id: number; kind: string; visit_id: string | null; error: string; created_at: string }[]> {
  return (await db()).getAllAsync("SELECT id, kind, visit_id, error, created_at FROM actions WHERE status = 'rejected' ORDER BY id");
}
export async function dismissRejected(id: number) {
  await (await db()).runAsync("DELETE FROM actions WHERE id = ?", [id]);
  emit();
}

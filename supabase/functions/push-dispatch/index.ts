// POST /functions/v1/push-dispatch  (scheduled; header  x-cron-secret: $CRON_SECRET)
// Drains notification_outbox → Expo Push Service (which relays to FCM / APNs), records tickets,
// retries with exponential backoff (in SQL), dead-letters after 6 attempts, deactivates
// DeviceNotRegistered tokens and later fetches receipts. The in-app inbox stays authoritative.
import { HttpError, serve, serviceClient } from "../_shared/http.ts";

const EXPO_SEND = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts";

function expoHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const token = Deno.env.get("EXPO_ACCESS_TOKEN");
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) throw new HttpError(401, "unauthenticated");
  const svc = serviceClient();

  const { data: batch, error } = await svc.rpc("claim_outbox_batch", { p_limit: 100 });
  if (error) throw new HttpError(500, "claim_failed", error.message);
  let sent = 0, failed = 0, skipped = 0;

  for (const row of batch ?? []) {
    const tokens: string[] = (row.tokens ?? []).filter((t: string) => /^Expo(nent)?PushToken\[.+\]$/.test(t));
    if (tokens.length === 0) {
      await svc.rpc("record_outbox_result", { p_id: row.id, p_ok: false, p_tickets: null, p_error: "no_active_device", p_invalid_tokens: [] });
      skipped++;
      continue;
    }
    const messages = tokens.map((to) => ({
      to,
      title: row.payload.title,
      body: row.payload.body,
      data: row.payload.data,
      sound: "default",
      priority: "high",
      channelId: "visits",
    }));
    try {
      const res = await fetch(EXPO_SEND, { method: "POST", headers: expoHeaders(), body: JSON.stringify(messages) });
      const out = await res.json();
      if (!res.ok || !Array.isArray(out.data)) throw new Error(`expo_http_${res.status}`);
      const invalid: string[] = [];
      const tickets = out.data.map((t: { status: string; id?: string; details?: { error?: string } }, i: number) => {
        if (t.status === "error" && t.details?.error === "DeviceNotRegistered") invalid.push(tokens[i]!);
        return { token_suffix: tokens[i]!.slice(-6), status: t.status, id: t.id ?? null, error: t.details?.error ?? null };
      });
      const anyOk = tickets.some((t: { status: string }) => t.status === "ok");
      await svc.rpc("record_outbox_result", {
        p_id: row.id, p_ok: anyOk, p_tickets: tickets, p_error: anyOk ? null : tickets[0]?.error ?? "expo_error", p_invalid_tokens: invalid,
      });
      anyOk ? sent++ : failed++;
    } catch (e) {
      await svc.rpc("record_outbox_result", { p_id: row.id, p_ok: false, p_tickets: null, p_error: (e as Error).message, p_invalid_tokens: [] });
      failed++;
    }
  }

  // Receipts: Expo makes them available ~15 min after sending.
  const { data: pendingReceipts } = await svc
    .from("notification_outbox")
    .select("id, provider_tickets")
    .eq("status", "sent")
    .is("provider_receipts", null)
    .lt("sent_at", new Date(Date.now() - 15 * 60e3).toISOString())
    .gt("sent_at", new Date(Date.now() - 24 * 3600e3).toISOString())
    .limit(100);
  let receipts = 0;
  for (const row of pendingReceipts ?? []) {
    const ids = (row.provider_tickets ?? []).map((t: { id: string | null }) => t.id).filter(Boolean);
    if (ids.length === 0) continue;
    const res = await fetch(EXPO_RECEIPTS, { method: "POST", headers: expoHeaders(), body: JSON.stringify({ ids }) });
    if (!res.ok) continue;
    const out = await res.json();
    await svc.rpc("record_outbox_receipts", { p_id: row.id, p_receipts: out.data ?? {}, p_invalid_tokens: [] });
    receipts++;
  }
  return { claimed: batch?.length ?? 0, sent, failed, skipped, receipts_checked: receipts };
});

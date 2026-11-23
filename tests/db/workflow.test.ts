import { beforeAll, describe, expect, test } from "vitest";
import type { Transaction } from "@electric-sql/pglite";
import { VISIT_STATUSES, VISIT_TRANSITIONS } from "../../packages/shared/src/constants";
import { admin, as, createDb, expectError, seedWorld, user, uuid, type Db, type World } from "./harness";

let db: Db;
let w: World;
const rpc = async <T = any>(tx: Transaction, sql: string, params: unknown[] = []): Promise<T> =>
  (await tx.query<{ r: T }>(`select ${sql} as r`, params)).rows[0]!.r;

beforeAll(async () => {
  db = await createDb();
  w = await seedWorld(db);
}, 60000);

const FARM = { lat: 18.7357, lon: 73.6755 };
const near = { lat: 18.7360, lon: 73.6757 }; // ~40 m
const far = { lat: 18.75, lon: 73.70 }; // ~3 km

async function newVisit(staff = w.amit, farmer = w.farmerA1, extra: object = {}) {
  const r = await as(db, admin(w.adminA), (tx) =>
    rpc(tx, `public.admin_create_visit($1::jsonb)`, [JSON.stringify({ farmer_id: farmer, staff_id: staff, scheduled_at: new Date(Date.now() + 600e3).toISOString(), ...extra })]),
  );
  return r.visit.id as string;
}
const staff = <T>(id: string, fn: (tx: Transaction) => Promise<T>) => as(db, user(id), fn);

test("SQL transition table matches shared TypeScript table", async () => {
  for (const from of VISIT_STATUSES) {
    for (const to of VISIT_STATUSES) {
      const r = await db.query<{ ok: boolean }>(`select private.visit_transition_allowed($1, $2) ok`, [from, to]);
      expect([from, to, r.rows[0]!.ok]).toEqual([from, to, VISIT_TRANSITIONS[from].includes(to)]);
    }
  }
});

describe("full visit lifecycle", () => {
  test("duty → start → arrive → complete → return → end duty, with separate timestamps", async () => {
    const id = await newVisit();
    await expectError(staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2)`, [id, uuid()])), "duty_not_started");
    await staff(w.amit, (tx) => rpc(tx, `public.start_duty('tracking')`));

    const k1 = uuid();
    const s1 = await staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2, $3, $4, 12)`, [id, k1, far.lat, far.lon]));
    expect(s1.status).toBe("in_progress");
    // replay is idempotent
    const s1b = await staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2, $3, $4, 12)`, [id, k1, far.lat, far.lon]));
    expect(s1b.replayed).toBe(true);

    // location batch with a duplicate and a teleport
    const p1 = uuid();
    const now = Date.now();
    const batch = [
      { client_event_id: p1, sequence: 1, device_time: new Date(now - 120e3).toISOString(), lat: far.lat, lon: far.lon, accuracy_m: 10 },
      { client_event_id: uuid(), sequence: 2, device_time: new Date(now - 60e3).toISOString(), lat: near.lat, lon: near.lon, accuracy_m: 15 },
      { client_event_id: uuid(), sequence: 3, device_time: new Date(now - 59e3).toISOString(), lat: 28.6, lon: 77.2, accuracy_m: 5 },
      { client_event_id: uuid(), sequence: 4, device_time: new Date(now).toISOString(), lat: 200, lon: 1, accuracy_m: 5 },
    ];
    const ing = await staff(w.amit, (tx) => rpc(tx, `public.ingest_location_batch($1::jsonb, $2)`, [JSON.stringify(batch), s1.trip.id]));
    expect(ing.accepted).toHaveLength(3);
    expect(ing.rejected).toHaveLength(1);
    expect(ing.accepted.find((a: any) => a.quality === "teleport")).toBeTruthy();
    const again = await staff(w.amit, (tx) => rpc(tx, `public.ingest_location_batch($1::jsonb, $2)`, [JSON.stringify([batch[0]]), s1.trip.id]));
    expect(again.accepted[0].duplicate).toBe(true);
    const latest = await as(db, admin(w.adminA), (tx) => tx.query<any>(`select lat, quality from public.latest_staff_position where staff_id = $1`, [w.amit]));
    expect(latest.rows[0].lat).toBeCloseTo(near.lat, 4); // teleport not used as latest

    // arrival far from the pin requires a reason, then is flagged
    await expectError(staff(w.amit, (tx) => rpc(tx, `public.staff_arrive_visit($1, $2, $3, $4, 10)`, [id, uuid(), far.lat, far.lon])), "reason_required");
    const arr = await staff(w.amit, (tx) => rpc(tx, `public.staff_arrive_visit($1, $2, $3, $4, 10, null, 'Farmer met me at the market')`, [id, uuid(), far.lat, far.lon]));
    expect(arr.status).toBe("arrived");
    expect(arr.flagged).toBe(true);

    await expectError(staff(w.amit, (tx) => rpc(tx, `public.staff_complete_visit($1, $2, '{}'::jsonb)`, [id, uuid()])), "validation");
    const followAt = new Date(Date.now() + 7 * 86400e3).toISOString();
    const kc = uuid();
    const done = await staff(w.amit, (tx) =>
      rpc(tx, `public.staff_complete_visit($1, $2, $3::jsonb)`, [id, kc, JSON.stringify({ outcome_text: "Demo done, farmer interested", products_discussed: [w.productA1, w.productB1], next_followup_at: followAt, next_action: "Bring samples" })]),
    );
    expect(done.status).toBe("completed");
    expect(done.follow_up_visit_id).toBeTruthy();
    const dup = await staff(w.amit, (tx) => rpc(tx, `public.staff_complete_visit($1, $2, $3::jsonb)`, [id, uuid(), JSON.stringify({ outcome_text: "again" })]));
    expect(dup.replayed).toBe(true);
    const followCount = await db.query<{ n: number }>(`select count(*)::int n from public.visits where parent_visit_id = $1`, [id]);
    expect(followCount.rows[0]!.n).toBe(1);
    const outcome = await db.query<any>(`select products_discussed from public.visit_outcomes where visit_id = $1`, [id]);
    expect(outcome.rows[0].products_discussed).toEqual([w.productA1]); // other-org product dropped

    const ret = await staff(w.amit, (tx) => rpc(tx, `public.staff_start_return($1, $2)`, [id, uuid()]));
    const end = await staff(w.amit, (tx) => rpc(tx, `public.staff_end_trip($1, $2)`, [ret.trip.id, uuid()]));
    expect(end.trip.status).toBe("ended");
    await staff(w.amit, (tx) => rpc(tx, `public.end_duty()`));

    const report = await as(db, admin(w.adminA), (tx) => tx.query<any>(`select * from public.report_visit_timeline(now() - interval '1 day', now() + interval '2 days') where visit_id = $1`, [id]));
    const row = report.rows[0];
    expect(row.departed_at && row.arrived_at && row.completed_at && row.return_started_at && row.return_ended_at).toBeTruthy();
    expect(row.arrival_flagged).toBe(true);

    // tracking after duty end is refused
    await expectError(staff(w.amit, (tx) => rpc(tx, `public.ingest_location_batch($1::jsonb)`, [JSON.stringify([batch[1]])])), "duty_not_started");
  });

  test("arrival inside geofence is not flagged; missing pin requires reason", async () => {
    await staff(w.amit, (tx) => rpc(tx, `public.start_duty('tracking')`));
    const id = await newVisit();
    await staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2)`, [id, uuid()]));
    const a = await staff(w.amit, (tx) => rpc(tx, `public.staff_arrive_visit($1, $2, $3, $4, 8)`, [id, uuid(), near.lat, near.lon]));
    expect(a.geofence).toBe("inside");
    expect(a.flagged).toBe(false);
    await staff(w.amit, (tx) => rpc(tx, `public.staff_complete_visit($1, $2, '{"outcome_text":"ok done"}'::jsonb)`, [id, uuid()]));

    const id2 = await newVisit(w.amit, w.farmerA2);
    await staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2)`, [id2, uuid()]));
    await expectError(staff(w.amit, (tx) => rpc(tx, `public.staff_arrive_visit($1, $2, $3, $4, 8)`, [id2, uuid(), near.lat, near.lon])), "reason_required");
    await staff(w.amit, (tx) => rpc(tx, `public.end_duty()`));
  });

  test("only one active trip per staff member", async () => {
    await staff(w.amit, (tx) => rpc(tx, `public.start_duty('tracking')`));
    const a = await newVisit();
    const b = await newVisit();
    await staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2)`, [a, uuid()]));
    await expectError(staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2)`, [b, uuid()])), "active_trip_exists");
    await staff(w.amit, (tx) => rpc(tx, `public.end_duty()`));
  });

  test("limited mode refuses location upload but task flow works", async () => {
    await staff(w.neha, (tx) => rpc(tx, `public.start_duty('limited')`));
    await expectError(staff(w.neha, (tx) => rpc(tx, `public.ingest_location_batch('[]'::jsonb)`)), "tracking_disabled");
    const id = await newVisit(w.neha);
    const s = await staff(w.neha, (tx) => rpc(tx, `public.staff_start_visit($1, $2)`, [id, uuid()]));
    expect(s.status).toBe("in_progress");
    await staff(w.neha, (tx) => rpc(tx, `public.end_duty()`));
  });

  test("invalid transitions and version conflicts are rejected", async () => {
    const id = await newVisit();
    await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_cancel_visit($1, 'farmer away')`, [id]));
    await expectError(as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_cancel_visit($1, 'again')`, [id])), "invalid_transition");
    await staff(w.amit, (tx) => rpc(tx, `public.start_duty('tracking')`));
    await expectError(staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2)`, [id, uuid()])), "invalid_transition");
    await staff(w.amit, (tx) => rpc(tx, `public.end_duty()`));
    const id2 = await newVisit();
    await expectError(as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_update_visit($1, 99, '{"priority":"high"}'::jsonb)`, [id2])), "version_conflict");
  });
});

test("travel mode is stored per trip and returned in staff_route; invalid modes rejected", async () => {
  await staff(w.neha, (tx) => rpc(tx, `public.start_duty('tracking')`));
  const id = await newVisit(w.neha);
  await expectError(staff(w.neha, (tx) => rpc(tx, `public.staff_start_visit(p_visit => $1, p_idempotency_key => $2, p_travel_mode => 'plane')`, [id, uuid()])), "validation");
  const r = await staff(w.neha, (tx) => rpc(tx, `public.staff_start_visit(p_visit => $1, p_idempotency_key => $2, p_travel_mode => 'bike')`, [id, uuid()]));
  expect(r.trip.travel_mode).toBe("bike");
  const route = await as(db, admin(w.adminA), (tx) => rpc(tx, `public.staff_route($1, now() - interval '1 day', now() + interval '1 day')`, [w.neha]));
  expect(route.trips.find((t: any) => t.visit_id === id).travel_mode).toBe("bike");
  await staff(w.neha, (tx) => rpc(tx, `public.end_duty()`));
});

test("confirming a farmer pin updates visits already on the way", async () => {
  await staff(w.amit, (tx) => rpc(tx, `public.start_duty('tracking')`));
  const id = await newVisit(w.amit, w.farmerA2); // farmer A2 has no pin
  await staff(w.amit, (tx) => rpc(tx, `public.staff_start_visit($1, $2)`, [id, uuid()]));
  await as(db, admin(w.adminA), (tx) => rpc(tx, `public.verify_farmer_location($1, 18.70, 73.60)`, [w.farmerA2]));
  const v = await db.query<any>(`select status, target_lat from public.visits where id = $1`, [id]);
  expect(v.rows[0]).toEqual({ status: "in_progress", target_lat: 18.7 });
  await staff(w.amit, (tx) => rpc(tx, `public.end_duty()`));
});

describe("purchases", () => {
  test("totals computed server-side with price snapshot; idempotent", async () => {
    const key = uuid();
    const items = JSON.stringify([{ product_id: w.productA1, quantity: "2.5" }, { product_id: w.productA1, quantity: 3, unit_price: "99.99" }]);
    const r = await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_create_purchase($1, now(), $2::jsonb, $3)`, [w.farmerA1, items, key]));
    expect(Number(r.total)).toBeCloseTo(2.5 * 128.5 + 3 * 99.99, 2);
    const again = await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_create_purchase($1, now(), $2::jsonb, $3)`, [w.farmerA1, items, key]));
    expect(again.replayed).toBe(true);
    await db.query(`update public.products set price = 500 where id = $1`, [w.productA1]);
    const li = await db.query<any>(`select unit_price from public.purchase_items where purchase_id = $1 order by unit_price desc`, [r.purchase_id]);
    expect(li.rows.map((x) => Number(x.unit_price))).toEqual([128.5, 99.99]);
    await expectError(
      as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_create_purchase($1, now(), $2::jsonb, $3)`, [w.farmerA1, JSON.stringify([{ product_id: w.productB1, quantity: 1 }]), uuid()])),
      "validation",
    );
  });
});

describe("farmers", () => {
  test("phone normalized, duplicates detected, pin edits clear verification", async () => {
    const f = await as(db, admin(w.adminA), (tx) => tx.query<any>(`insert into public.farmers (name, phone, lat, lon, location_verified) values ('Dup Test', '+91 90000 00001', 18.5, 73.5, true) returning *`));
    expect(f.rows[0].normalized_phone).toBe("+919000000001");
    expect(f.rows[0].location_verified).toBe(false); // cannot self-verify via insert
    const d = await as(db, admin(w.adminA), (tx) => tx.query<any>(`select * from public.find_farmer_duplicates('09000000001', null, $1)`, [f.rows[0].id]));
    expect(d.rows.map((x) => x.id)).toContain(w.farmerA1);
    await as(db, admin(w.adminA), (tx) => rpc(tx, `public.verify_farmer_location($1, 18.51, 73.51)`, [f.rows[0].id]));
    const v = await db.query<any>(`select location_verified from public.farmers where id = $1`, [f.rows[0].id]);
    expect(v.rows[0].location_verified).toBe(true);
    await as(db, admin(w.adminA), (tx) => tx.query(`update public.farmers set lat = 18.52 where id = $1`, [f.rows[0].id]));
    const v2 = await db.query<any>(`select location_verified from public.farmers where id = $1`, [f.rows[0].id]);
    expect(v2.rows[0].location_verified).toBe(false);
    await expectError(as(db, admin(w.adminA), (tx) => tx.query(`insert into public.farmers (name, phone) values ('Bad', '12')`)), "validation");
  });
});

describe("notifications outbox", () => {
  test("assignment enqueues one outbox row; dispatcher claims, retries with backoff, dead-letters", async () => {
    const id = await newVisit(w.neha);
    await staff(w.neha, (tx) => rpc(tx, `public.register_push_token('ExponentPushToken[test-neha-123]', 'android')`));
    const pending = await db.query<any>(`select * from public.notification_outbox where visit_id = $1`, [id]);
    expect(pending.rows).toHaveLength(1);
    expect(JSON.stringify(pending.rows[0].payload)).not.toContain("Farmer");
    await db.query(`update public.notification_outbox set status = 'sent' where visit_id <> $1 or visit_id is null`, [id]);
    const claimed = await db.query<any>(`select * from public.claim_outbox_batch(10)`);
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0].tokens).toEqual(["ExponentPushToken[test-neha-123]"]);
    await db.query(`select public.record_outbox_result($1, false, null, 'network', '{}')`, [claimed.rows[0].id]);
    const f = await db.query<any>(`select status, next_attempt_at > now() as later from public.notification_outbox where id = $1`, [claimed.rows[0].id]);
    expect(f.rows[0]).toEqual({ status: "failed", later: true });
    await db.query(`update public.notification_outbox set attempts = 6 where id = $1`, [claimed.rows[0].id]);
    await db.query(`select public.record_outbox_result($1, false, null, 'network', array['ExponentPushToken[test-neha-123]'])`, [claimed.rows[0].id]);
    const dead = await db.query<any>(`select status from public.notification_outbox where id = $1`, [claimed.rows[0].id]);
    expect(dead.rows[0].status).toBe("dead");
    const tok = await db.query<any>(`select active from public.device_tokens where token = 'ExponentPushToken[test-neha-123]'`);
    expect(tok.rows[0].active).toBe(false);
  });

  test("authenticated users cannot call service-only functions", async () => {
    await expectError(as(db, admin(w.adminA), (tx) => tx.query(`select * from public.claim_outbox_batch(10)`)), /permission denied/);
    await expectError(as(db, admin(w.adminA), (tx) => tx.query(`select public.purge_expired_data()`)), /permission denied/);
  });

  test("reminders are deduplicated", async () => {
    await newVisit(w.amit);
    const a = await db.query<{ n: number }>(`select public.enqueue_due_reminders() n`);
    const before = await db.query<{ n: number }>(`select count(*)::int n from public.user_notifications where type = 'visit_reminder'`);
    await db.query(`select public.enqueue_due_reminders()`);
    const after = await db.query<{ n: number }>(`select count(*)::int n from public.user_notifications where type = 'visit_reminder'`);
    expect(a.rows[0]!.n).toBeGreaterThan(0);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe("settings", () => {
  test("validated and only owner can change MFA requirement", async () => {
    const s = await as(db, admin(w.adminA), (tx) => rpc(tx, `public.update_org_settings('{"arrival_radius_m": 150}'::jsonb)`));
    expect(s.arrival_radius_m).toBe(150);
    await expectError(as(db, admin(w.adminA), (tx) => rpc(tx, `public.update_org_settings('{"arrival_radius_m": "x"}'::jsonb)`)), "validation");
    await expectError(as(db, admin(w.adminA), (tx) => rpc(tx, `public.update_org_settings('{"evil": 1}'::jsonb)`)), "validation");
    await expectError(as(db, admin(w.adminA), (tx) => rpc(tx, `public.update_org_settings('{"require_admin_mfa": false}'::jsonb)`)), "forbidden");
    await expectError(as(db, admin(w.adminA), (tx) => rpc(tx, `public.update_org_settings('{"map_tile_url": "http://insecure/{z}"}'::jsonb)`)), "validation");
  });
});

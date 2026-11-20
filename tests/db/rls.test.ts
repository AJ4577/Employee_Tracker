import { beforeAll, describe, expect, test } from "vitest";
import type { Transaction } from "@electric-sql/pglite";
import { admin, as, createDb, expectError, seedWorld, user, uuid, type Db, type World } from "./harness";

let db: Db;
let w: World;

const rpc = async <T = any>(tx: Transaction, sql: string, params: unknown[] = []): Promise<T> => {
  const r = await tx.query<{ r: T }>(`select ${sql} as r`, params);
  return r.rows[0]!.r;
};
const rows = async (tx: Transaction, sql: string, params: unknown[] = []) => (await tx.query<any>(sql, params)).rows;

async function createVisit(staff: string, farmer: string, opts: Record<string, unknown> = {}) {
  return as(db, admin(w.adminA), (tx) =>
    rpc(tx, `public.admin_create_visit($1::jsonb)`, [
      JSON.stringify({ farmer_id: farmer, staff_id: staff, scheduled_at: new Date(Date.now() + 3600e3).toISOString(), type: "meeting", instructions: "Discuss soybean", ...opts }),
    ]),
  );
}

beforeAll(async () => {
  db = await createDb();
  w = await seedWorld(db);
}, 60000);

describe("anonymous", () => {
  test("cannot read any protected table", async () => {
    for (const t of ["farmers", "products", "visits", "profiles", "location_points", "latest_staff_position", "purchases"]) {
      await expectError(as(db, null, (tx) => rows(tx, `select * from public.${t}`)), /permission denied/);
    }
  });
  test("cannot call RPCs", async () => {
    await expectError(as(db, null, (tx) => rpc(tx, `public.me()`)), /permission denied/);
    await expectError(as(db, null, (tx) => rpc(tx, `public.my_visits()`)), /permission denied/);
  });
});

describe("tenant isolation", () => {
  test("admin A sees only org A farmers/products/profiles", async () => {
    const r = await as(db, admin(w.adminA), async (tx) => ({
      farmers: await rows(tx, `select id from public.farmers`),
      products: await rows(tx, `select id from public.products`),
      profiles: await rows(tx, `select organization_id from public.profiles`),
    }));
    expect(r.farmers.map((x) => x.id).sort()).toEqual([w.farmerA1, w.farmerA2].sort());
    expect(r.products.map((x) => x.id)).toEqual([w.productA1]);
    expect(new Set(r.profiles.map((x) => x.organization_id))).toEqual(new Set([w.orgA]));
  });

  test("client-supplied organization_id is ignored on insert", async () => {
    const r = await as(db, admin(w.adminA), (tx) =>
      rows(tx, `insert into public.products (organization_id, sku, name, unit) values ($1, 'X-1', 'Injected', 'kg') returning organization_id`, [w.orgB]),
    );
    expect(r[0].organization_id).toBe(w.orgA);
  });

  test("admin A cannot update org B rows or move a row to org B", async () => {
    const n = await as(db, admin(w.adminA), (tx) => tx.query(`update public.farmers set name = 'hacked' where id = $1`, [w.farmerB1]));
    expect(n.affectedRows).toBe(0);
    await expectError(as(db, admin(w.adminA), (tx) => tx.query(`update public.farmers set organization_id = $1 where id = $2`, [w.orgB, w.farmerA1])), /forbidden|row-level security/);
  });

  test("admin A cannot assign visit to org B staff or farmer", async () => {
    await expectError(createVisit(w.staffB, w.farmerA1), "validation");
    await expectError(createVisit(w.amit, w.farmerB1), "validation");
  });

  test("admin B gets not_found for org A visit", async () => {
    const v = await createVisit(w.amit, w.farmerA1);
    await expectError(as(db, admin(w.adminB), (tx) => rpc(tx, `public.admin_visit_detail($1)`, [v.visit.id])), "not_found");
    await expectError(as(db, admin(w.adminB), (tx) => rpc(tx, `public.admin_cancel_visit($1, 'cross tenant')`, [v.visit.id])), "not_found");
  });
});

describe("admin MFA", () => {
  test("admin without aal2 is treated as non-admin when org requires MFA", async () => {
    const r = await as(db, user(w.adminA), (tx) => rows(tx, `select id from public.farmers`));
    expect(r).toEqual([]);
    await expectError(as(db, user(w.adminA), (tx) => rpc(tx, `public.admin_overview(now() - interval '1 day', now())`)), "forbidden");
  });
  test("org B (MFA disabled) admin works on aal1", async () => {
    const r = await as(db, user(w.adminB), (tx) => rows(tx, `select id from public.farmers`));
    expect(r.map((x) => x.id)).toEqual([w.farmerB1]);
  });
});

describe("staff boundaries", () => {
  test("staff cannot browse farmers, products, purchases or other profiles directly", async () => {
    const r = await as(db, user(w.amit), async (tx) => ({
      farmers: await rows(tx, `select * from public.farmers`),
      products: await rows(tx, `select * from public.products`),
      purchases: await rows(tx, `select * from public.purchases`),
      profiles: await rows(tx, `select id from public.profiles`),
    }));
    expect(r.farmers).toEqual([]);
    expect(r.products).toEqual([]);
    expect(r.purchases).toEqual([]);
    expect(r.profiles.map((x) => x.id)).toEqual([w.amit]);
  });

  test("staff cannot write farmers/products or call admin RPCs", async () => {
    await expectError(as(db, user(w.amit), (tx) => tx.query(`insert into public.farmers (name) values ('x')`)), /row-level security|forbidden/);
    await expectError(as(db, user(w.amit), (tx) => rpc(tx, `public.admin_create_visit('{}'::jsonb)`)), "forbidden");
    await expectError(as(db, user(w.amit), (tx) => rpc(tx, `public.admin_set_staff_status($1, 'suspended')`, [w.neha])), "forbidden");
    await expectError(as(db, user(w.amit), (tx) => tx.query(`update public.profiles set role = 'admin' where id = $1`, [w.amit])), /permission denied/);
  });

  test("staff sees only own assigned visit; peer gets not_found", async () => {
    const v = await createVisit(w.amit, w.farmerA1);
    const mine = await as(db, user(w.amit), (tx) => rpc<any[]>(tx, `public.my_visits()`));
    expect(mine.some((x) => x.id === v.visit.id)).toBe(true);
    const peer = await as(db, user(w.neha), (tx) => rpc<any[]>(tx, `public.my_visits()`));
    expect(peer.some((x) => x.id === v.visit.id)).toBe(false);
    await expectError(as(db, user(w.neha), (tx) => rpc(tx, `public.my_visit_detail($1)`, [v.visit.id])), "not_found");
    const nehaRows = await as(db, user(w.neha), (tx) => rows(tx, `select id from public.visits where id = $1`, [v.visit.id]));
    expect(nehaRows).toEqual([]);
  });

  test("staff cannot read another staff member's location or route", async () => {
    await expectError(as(db, user(w.neha), (tx) => rpc(tx, `public.staff_route($1, now() - interval '1 day', now())`, [w.amit])), "not_found");
    const lp = await as(db, user(w.neha), (tx) => rows(tx, `select * from public.latest_staff_position where staff_id = $1`, [w.amit]));
    expect(lp).toEqual([]);
  });

  test("staff cannot insert location points directly or push events for others", async () => {
    await expectError(
      as(db, user(w.amit), (tx) => tx.query(`insert into public.location_points (organization_id, staff_id, client_event_id, sequence, device_time, lat, lon, accuracy_m) values ($1, $2, $3, 1, now(), 1, 1, 5)`, [w.orgA, w.neha, uuid()])),
      /permission denied/,
    );
  });
});

describe("reassignment and suspension", () => {
  test("reassignment removes old staff access and notifies new staff", async () => {
    const v = await createVisit(w.amit, w.farmerA1);
    await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_reassign_visit($1, $2, 'Amit on leave')`, [v.visit.id, w.neha]));
    await expectError(as(db, user(w.amit), (tx) => rpc(tx, `public.my_visit_detail($1)`, [v.visit.id])), "not_found");
    const d = await as(db, user(w.neha), (tx) => rpc<any>(tx, `public.my_visit_detail($1)`, [v.visit.id]));
    expect(d.farmer.name).toBe("Farmer A1");
    const notes = await as(db, user(w.neha), (tx) => rows(tx, `select type, title, body from public.user_notifications where visit_id = $1`, [v.visit.id]));
    expect(notes.some((n) => n.type === "visit_assigned")).toBe(true);
    // lock-screen-safe wording: no farmer name in title/body
    expect(JSON.stringify(notes)).not.toContain("Farmer A1");
  });

  test("suspended staff loses all data access and cannot mutate", async () => {
    const v = await createVisit(w.neha, w.farmerA1);
    await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_set_staff_status($1, 'suspended', 'test')`, [w.neha]));
    const r = await as(db, user(w.neha), (tx) => rows(tx, `select id from public.visits`));
    expect(r).toEqual([]);
    await expectError(as(db, user(w.neha), (tx) => rpc(tx, `public.my_visits()`)), "forbidden");
    await expectError(as(db, user(w.neha), (tx) => rpc(tx, `public.start_duty()`)), "forbidden");
    await expectError(as(db, user(w.neha), (tx) => rpc(tx, `public.my_visit_detail($1)`, [v.visit.id])), "forbidden");
    await as(db, admin(w.adminA), (tx) => rpc(tx, `public.admin_set_staff_status($1, 'active')`, [w.neha]));
  });
});

describe("append-only and audit", () => {
  test("visit_events and audit_log cannot be modified", async () => {
    await expectError(db.query(`update public.visit_events set reason = 'x'`), "append_only");
    await expectError(db.query(`delete from public.audit_log`), "append_only");
  });
  test("audit log does not contain phone numbers", async () => {
    const r = await db.query<{ diff: unknown }>(`select diff from public.audit_log where entity = 'farmers'`);
    expect(JSON.stringify(r.rows)).not.toContain("9000000001");
  });
});
